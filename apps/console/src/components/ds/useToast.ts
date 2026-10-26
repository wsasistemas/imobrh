import { useCallback, useEffect, useRef, useState } from "react";

/** Mensagem do Toast, que some sozinha depois de 4,5s (como na referência). */
export function useToast(duration = 4500) {
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const show = useCallback(
    (text: string) => {
      setMessage(text);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setMessage(""), duration);
    },
    [duration],
  );

  useEffect(() => () => clearTimeout(timer.current), []);

  return { message, show };
}
