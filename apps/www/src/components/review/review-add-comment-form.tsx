"use client";

import { useCallback, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PlusIcon, XIcon } from "lucide-react";
import { addHumanComment } from "@/server-actions/review-detail";
import type { ReviewCommentPriority } from "@/types/review";

interface ReviewAddCommentFormProps {
  reviewId: string;
  onCommentAdded: () => void;
}

export function ReviewAddCommentForm({
  reviewId,
  onCommentAdded,
}: ReviewAddCommentFormProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [file, setFile] = useState("");
  const [line, setLine] = useState("");
  const [priority, setPriority] = useState<ReviewCommentPriority>("medium");
  const [body, setBody] = useState("");
  const [isPending, startTransition] = useTransition();

  const resetForm = useCallback(() => {
    setFile("");
    setLine("");
    setPriority("medium");
    setBody("");
  }, []);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!file.trim() || !body.trim()) return;

      startTransition(async () => {
        await addHumanComment(reviewId, {
          file: file.trim(),
          line: line ? Number(line) : undefined,
          priority,
          body: body.trim(),
        });
        resetForm();
        setIsOpen(false);
        onCommentAdded();
      });
    },
    [file, line, priority, body, reviewId, resetForm, onCommentAdded],
  );

  if (!isOpen) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => setIsOpen(true)}
        className="w-full"
      >
        <PlusIcon className="h-4 w-4" />
        Add Comment
      </Button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-lg border border-border/50 bg-card/50 p-4 flex flex-col gap-3"
    >
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-foreground">New Comment</h4>
        <button
          type="button"
          onClick={() => {
            resetForm();
            setIsOpen(false);
          }}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <XIcon className="h-4 w-4" />
        </button>
      </div>

      <div className="flex gap-2">
        <Input
          placeholder="File path (e.g. src/lib/auth.ts)"
          value={file}
          onChange={(e) => setFile(e.target.value)}
          className="flex-1 h-9 text-sm"
          required
        />
        <Input
          type="number"
          placeholder="Line"
          value={line}
          onChange={(e) => setLine(e.target.value)}
          className="w-20 h-9 text-sm"
        />
      </div>

      <Select
        value={priority}
        onValueChange={(v) => setPriority(v as ReviewCommentPriority)}
      >
        <SelectTrigger size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="high">HIGH</SelectItem>
          <SelectItem value="medium">MEDIUM</SelectItem>
          <SelectItem value="low">LOW</SelectItem>
        </SelectContent>
      </Select>

      <Textarea
        placeholder="Comment body..."
        value={body}
        onChange={(e) => setBody(e.target.value)}
        className="min-h-[80px] text-sm"
        required
      />

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            resetForm();
            setIsOpen(false);
          }}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={isPending || !file.trim() || !body.trim()}
        >
          {isPending ? "Adding..." : "Add Comment"}
        </Button>
      </div>
    </form>
  );
}
