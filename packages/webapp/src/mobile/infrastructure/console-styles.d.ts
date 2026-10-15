import "react";

// Shared Next console components render these as ordinary style elements in Vite.
declare module "react" {
  interface StyleHTMLAttributes<T> { jsx?: boolean; global?: boolean }
}
