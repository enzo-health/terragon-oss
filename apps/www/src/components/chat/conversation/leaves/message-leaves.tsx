"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ai/button";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStepStatic,
  ChainOfThoughtIcon,
} from "@/components/ai/chain-of-thought";
import {
  Message,
  MessageAction,
  MessageContent,
  MessageText,
} from "@/components/ai/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai/reasoning";
import { cn } from "@/lib/utils";
import { ImagePart } from "../../image-part";
import { TextPart } from "../../text-part";
import type { Leaf } from "../leaf-props";
import { useIsSeeded } from "../seeded-context";

function CopyMessageAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const onCopy = () => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <MessageAction className="opacity-0 transition-opacity focus-within:opacity-100 group-hover/message:opacity-100">
      <Button
        variant="ghost"
        iconOnly
        onClick={onCopy}
        aria-label="Copy message"
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </MessageAction>
  );
}

export const TextLeaf: Leaf<"text"> = ({ item }) => {
  const seeded = useIsSeeded(item.key);
  return (
    <Message
      type="incoming"
      className={cn(
        !seeded &&
          "animate-in fade-in duration-[var(--duration-quick)] ease-[var(--ease-emphasis)] motion-reduce:animate-none",
      )}
    >
      <MessageContent className="break-words text-sm leading-relaxed">
        <MessageText variant="plain">
          <TextPart text={item.text} streaming={item.streaming} />
        </MessageText>
        {item.streaming ? null : <CopyMessageAction text={item.text} />}
      </MessageContent>
    </Message>
  );
};

export const ReasoningLeaf: Leaf<"reasoning"> = ({ item }) => {
  const [open, setOpen] = useState(item.streaming);

  useEffect(() => {
    if (!item.streaming) setOpen(false);
  }, [item.streaming]);

  if (item.steps.length > 0) {
    return (
      <ChainOfThought
        open={open}
        onOpenChange={setOpen}
        defaultOpen={item.streaming}
      >
        <ChainOfThoughtHeader>Thinking</ChainOfThoughtHeader>
        <ChainOfThoughtContent>
          {item.steps.map((step, index) => (
            <ChainOfThoughtStepStatic key={index}>
              <ChainOfThoughtIcon />
              <TextPart text={step.text} />
            </ChainOfThoughtStepStatic>
          ))}
        </ChainOfThoughtContent>
      </ChainOfThought>
    );
  }

  return (
    <Reasoning open={open} onOpenChange={setOpen}>
      <ReasoningTrigger>Thinking</ReasoningTrigger>
      <ReasoningContent keepMounted>
        <TextPart text={item.text} streaming={item.streaming} />
      </ReasoningContent>
    </Reasoning>
  );
};

export const UserLeaf: Leaf<"user"> = ({ item }) => {
  const seeded = useIsSeeded(item.key);
  const copyText = item.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
  return (
    <Message
      type="outgoing"
      className={cn(
        "py-2",
        !seeded &&
          "animate-in fade-in slide-in-from-bottom-2 duration-[var(--duration-base)] ease-[var(--ease-emphasis)] motion-reduce:animate-none",
      )}
    >
      <MessageContent>
        <MessageText variant="bubble">
          {item.content.map((part, index) => {
            if (part.type === "text") {
              return <TextPart key={index} text={part.text} />;
            }
            if (part.type === "image" && part.url) {
              return <ImagePart key={index} imageUrl={part.url} />;
            }
            return null;
          })}
        </MessageText>
        {copyText ? <CopyMessageAction text={copyText} /> : null}
      </MessageContent>
    </Message>
  );
};
