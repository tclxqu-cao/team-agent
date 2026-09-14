import { createContext, type ReactNode } from "react";
/** Web-only controls are supplied by the WebApp composition root. */
export const BrowserLiveHeaderContext = createContext<ReactNode>(null);
