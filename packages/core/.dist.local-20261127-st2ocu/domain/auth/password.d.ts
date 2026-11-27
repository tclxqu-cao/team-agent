export interface PasswordRecord {
    hash: Buffer;
    salt: Buffer;
    version: number;
}
export declare const PASSWORD_VERSION = 1;
export declare function hashPassword(password: string): Promise<PasswordRecord>;
export declare function verifyPassword(password: string, record: PasswordRecord): Promise<boolean>;
//# sourceMappingURL=password.d.ts.map