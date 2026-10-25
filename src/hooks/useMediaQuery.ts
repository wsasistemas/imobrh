import { useSyncExternalStore } from "react";

/** true enquanto a media query casar (ex.: "(max-width: 1279px)"); acompanha o redimensionamento. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
  );
}
