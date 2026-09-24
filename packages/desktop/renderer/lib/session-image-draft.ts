const IMAGE_DRAFT_DATABASE = "agentroam-composer-drafts";
const IMAGE_DRAFT_DATABASE_VERSION = 1;
const IMAGE_DRAFT_STORE = "session-image-drafts";

interface SessionImageDraftRecord {
  sessionId: string;
  images: string[];
}

export interface SessionImageDraftRepository {
  read(sessionId: string): Promise<string[]>;
  write(sessionId: string, images: string[]): Promise<void>;
  clear(sessionId: string): Promise<void>;
}

function normalizeStoredImages(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const images = (value as { images?: unknown }).images;
  if (!Array.isArray(images)) return [];
  return images.filter(
    (image): image is string => typeof image === "string" && image.startsWith("data:image/"),
  );
}

export class IndexedDbSessionImageDraftRepository implements SessionImageDraftRepository {
  private readonly factory: IDBFactory | null;
  private databasePromise: Promise<IDBDatabase | null> | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(factory?: IDBFactory | null) {
    this.factory = factory === undefined
      ? (typeof indexedDB === "undefined" ? null : indexedDB)
      : factory;
  }

  async read(sessionId: string): Promise<string[]> {
    if (!sessionId || !this.factory) return [];
    await this.mutationQueue;
    const database = await this.openDatabase();
    if (!database) return [];

    return await new Promise<string[]>((resolve) => {
      try {
        const transaction = database.transaction(IMAGE_DRAFT_STORE, "readonly");
        const request = transaction.objectStore(IMAGE_DRAFT_STORE).get(sessionId);
        request.onsuccess = () => resolve(normalizeStoredImages(request.result));
        request.onerror = () => resolve([]);
        transaction.onabort = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  }

  write(sessionId: string, images: string[]): Promise<void> {
    if (!sessionId || !this.factory) return Promise.resolve();
    const normalized = normalizeStoredImages({ images });
    return this.enqueueMutation(async () => {
      const database = await this.openDatabase();
      if (!database) return;
      await this.runMutation(database, (store) => {
        if (normalized.length === 0) store.delete(sessionId);
        else store.put({ sessionId, images: normalized } satisfies SessionImageDraftRecord);
      });
    });
  }

  clear(sessionId: string): Promise<void> {
    if (!sessionId || !this.factory) return Promise.resolve();
    return this.enqueueMutation(async () => {
      const database = await this.openDatabase();
      if (!database) return;
      await this.runMutation(database, (store) => store.delete(sessionId));
    });
  }

  private enqueueMutation(mutation: () => Promise<void>): Promise<void> {
    const queued = this.mutationQueue.then(mutation, mutation).catch(() => undefined);
    this.mutationQueue = queued;
    return queued;
  }

  private openDatabase(): Promise<IDBDatabase | null> {
    if (this.databasePromise) return this.databasePromise;
    if (!this.factory) return Promise.resolve(null);

    this.databasePromise = new Promise<IDBDatabase | null>((resolve) => {
      try {
        const request = this.factory!.open(IMAGE_DRAFT_DATABASE, IMAGE_DRAFT_DATABASE_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(IMAGE_DRAFT_STORE)) {
            database.createObjectStore(IMAGE_DRAFT_STORE, { keyPath: "sessionId" });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return this.databasePromise;
  }

  private runMutation(
    database: IDBDatabase,
    mutate: (store: IDBObjectStore) => void,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      try {
        const transaction = database.transaction(IMAGE_DRAFT_STORE, "readwrite");
        mutate(transaction.objectStore(IMAGE_DRAFT_STORE));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => resolve();
        transaction.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  }
}

export class SessionImageDraftCoordinator {
  private selectedSessionId: string | null = null;
  private selectionGeneration = 0;

  constructor(private readonly repository: SessionImageDraftRepository) {}

  async restore(
    sessionId: string | null | undefined,
  ): Promise<{ sessionId: string; images: string[] } | null> {
    const generation = ++this.selectionGeneration;
    this.selectedSessionId = sessionId ?? null;
    if (!sessionId) return null;

    const images = await this.repository.read(sessionId);
    if (generation !== this.selectionGeneration || this.selectedSessionId !== sessionId) return null;
    return { sessionId, images };
  }

  save(sessionId: string, images: string[]): Promise<void> {
    this.invalidatePendingRestore(sessionId);
    return this.repository.write(sessionId, images);
  }

  saveSelected(sessionId: string, images: string[]): Promise<void> {
    if (this.selectedSessionId !== sessionId) return Promise.resolve();
    return this.repository.write(sessionId, images);
  }

  clear(sessionId: string): Promise<void> {
    this.invalidatePendingRestore(sessionId);
    return this.repository.clear(sessionId);
  }

  private invalidatePendingRestore(sessionId: string): void {
    if (this.selectedSessionId === sessionId) this.selectionGeneration += 1;
  }
}
