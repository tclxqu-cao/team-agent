export interface ZCodeDesktopTarget {
    id: string;
    cwd: string;
    workspaceIdentity?: string;
    readOnly?: boolean;
}
export interface ZCodeDesktopQuestionAnswer {
    question: string;
    answer: string;
}
export interface ZCodeDesktopGuide {
    available(session: ZCodeDesktopTarget): Promise<boolean>;
    read?(session: ZCodeDesktopTarget): Promise<Record<string, unknown>>;
    steer(session: ZCodeDesktopTarget, input: string, messageId?: string): Promise<boolean>;
    answerQuestion?(session: ZCodeDesktopTarget, interactionId: string, answer: ZCodeDesktopQuestionAnswer): Promise<boolean>;
}
/** Borrow the desktop owner. This client never resumes or spawns its session. */
export declare class ZCodeDesktopBridge implements ZCodeDesktopGuide {
    private readonly options;
    private readonly directory;
    private readonly guides;
    private readonly owners;
    private readonly answers;
    constructor(options?: {
        directory?: string;
        isAlive?: (pid: number) => boolean;
    });
    private descriptors;
    private request;
    private owner;
    available(session: ZCodeDesktopTarget): Promise<boolean>;
    read(session: ZCodeDesktopTarget): Promise<Record<string, unknown>>;
    steer(session: ZCodeDesktopTarget, input: string, messageId?: string): Promise<boolean>;
    answerQuestion(session: ZCodeDesktopTarget, interactionId: string, answer: ZCodeDesktopQuestionAnswer): Promise<boolean>;
    private queryAnswer;
    private acceptedAnswer;
}
//# sourceMappingURL=zcode-desktop-bridge.d.ts.map