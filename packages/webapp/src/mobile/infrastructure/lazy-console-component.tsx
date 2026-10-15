import { lazy, Suspense, type ComponentType, type ReactNode } from "react";

/** Vite counterpart of Next's client-only dynamic import used by the shared console. */
export default function dynamic<P extends object>(load: () => Promise<{ default: ComponentType<P> }>, options?: { ssr?: boolean; loading?: () => ReactNode }): ComponentType<P> {
  const Component = lazy(load) as unknown as ComponentType<P>;
  return function LazyConsoleComponent(props: P) {
    return <Suspense fallback={options?.loading?.() ?? null}><Component {...props} /></Suspense>;
  };
}
