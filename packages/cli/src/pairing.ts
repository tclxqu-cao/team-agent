import{createHash,randomBytes}from"node:crypto";
export interface PairingSecret{token:string;hashHex:string;expiresAt:string}
export function createPairingSecret(now=Date.now()):PairingSecret{const token=randomBytes(32).toString("base64url");return{token,hashHex:createHash("sha256").update(token).digest("hex"),expiresAt:new Date(now+5*60*1000).toISOString()};}
