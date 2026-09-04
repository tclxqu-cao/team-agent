const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

interface ComposerFile {
  name: string;
  type: string;
}

export interface PreparedComposerFiles<T extends ComposerFile> {
  images: string[];
  attachments: T[];
  unsupportedImages: T[];
  failedImages: T[];
}

export async function prepareComposerFiles<T extends ComposerFile>(
  files: readonly T[],
  readImage: (file: T) => Promise<string>,
): Promise<PreparedComposerFiles<T>> {
  const imageFiles: T[] = [];
  const attachments: T[] = [];
  const unsupportedImages: T[] = [];

  for (const file of files) {
    const type = file.type.trim().toLowerCase();
    if (!type.startsWith("image/")) {
      attachments.push(file);
    } else if (SUPPORTED_IMAGE_TYPES.has(type)) {
      imageFiles.push(file);
    } else {
      unsupportedImages.push(file);
    }
  }

  const results = await Promise.all(imageFiles.map(async (file) => {
    try {
      return { file, dataUrl: await readImage(file) } as const;
    } catch {
      return { file, dataUrl: null } as const;
    }
  }));

  return {
    images: results.flatMap((result) => result.dataUrl ? [result.dataUrl] : []),
    attachments,
    unsupportedImages,
    failedImages: results.flatMap((result) => result.dataUrl ? [] : [result.file]),
  };
}
