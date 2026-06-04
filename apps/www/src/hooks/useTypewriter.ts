"use client";

import { useEffect, useState } from "react";

const examples = [
  "Give me a high-level overview of the codebase…",
  "Analyze test coverage gaps and implement missing unit tests…",
  "Build a REST API endpoint with proper error handling and validation…",
  "Add a new feature that allows users to…",
];

export function useTypewriterEffect(isEnabled: boolean) {
  const [text, setText] = useState("");
  const [currentIndex] = useState(() =>
    Math.floor(Math.random() * examples.length),
  );

  useEffect(() => {
    if (!isEnabled) return;

    const targetText = examples[currentIndex]!;
    let currentLength = 0;
    let timeoutId: NodeJS.Timeout;

    const typeNextChar = () => {
      if (currentLength < targetText.length) {
        setText(targetText.slice(0, currentLength + 1));
        currentLength++;
        timeoutId = setTimeout(typeNextChar, 30);
      }
    };

    typeNextChar();

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [isEnabled, currentIndex]);

  return text;
}
