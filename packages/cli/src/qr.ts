import qrcode from"qrcode-terminal";
export function renderQr(url:string):Promise<string>{return new Promise(resolve=>qrcode.generate(url,{small:true},value=>resolve(value)));}
