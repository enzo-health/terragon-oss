"use client";

import React, { useEffect, useRef, useState } from "react";

const KONAMI_SEQUENCE = [
  "ArrowUp",
  "ArrowUp",
  "ArrowDown",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowLeft",
  "ArrowRight",
  "b",
  "a",
];

type KonamiVideoProps = {
  startSeconds?: number;
};

export function KonamiVideo({ startSeconds = 155 }: KonamiVideoProps) {
  const [show, setShow] = useState(false);
  const posRef = useRef(0);

  useEffect(() => {
    const normalizeKey = (key: string) =>
      key.startsWith("Arrow") ? key : key.toLowerCase();

    const onKeyDown = (e: KeyboardEvent) => {
      if (show) return; // don't listen while showing
      const expected = KONAMI_SEQUENCE[posRef.current] ?? "";
      const ok = normalizeKey(e.key) === normalizeKey(expected);
      if (ok) {
        posRef.current += 1;
        if (posRef.current === KONAMI_SEQUENCE.length) {
          setShow(true);
          posRef.current = 0;
        }
      } else {
        posRef.current =
          normalizeKey(e.key) === normalizeKey(KONAMI_SEQUENCE[0] ?? "")
            ? 1
            : 0;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [show]);

  if (!show) return null;

  const src = `https://www.youtube.com/embed/7ghSziUQnhs?start=${startSeconds}`;

  return (
    <div className="hidden lg:block fixed bottom-4 right-4 z-20 w-[360px] rounded-xl overflow-hidden border border-hairline bg-raised shadow-xl">
      <button
        aria-label="Close video"
        className="absolute right-2 top-2 z-10 h-6 w-6 rounded-full bg-raised/80 border border-hairline hover:bg-raised text-strong/80"
        onClick={() => setShow(false)}
      >
        ×
      </button>
      <div className="aspect-video">
        <iframe
          className="h-full w-full"
          src={src}
          title="Subway Surfers Gameplay"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          loading="lazy"
        />
      </div>
    </div>
  );
}
