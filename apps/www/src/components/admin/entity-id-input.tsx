"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface EntityIdInputProps {
  placeholder: string;
  onSubmit: (value: string) => void;
  className?: string;
}

export function EntityIdInput({
  placeholder,
  onSubmit,
  className,
}: EntityIdInputProps) {
  const [value, setValue] = useState("");

  const handleSubmit = () => {
    onSubmit(value);
  };

  return (
    <div className={`flex gap-2 ${className ?? ""}`}>
      <Input
        placeholder={placeholder}
        className="font-mono text-sm"
        value={value}
        autoComplete="off"
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            handleSubmit();
          }
        }}
        onChange={(e) => {
          setValue(e.currentTarget.value);
        }}
      />
      <Button variant="outline" onClick={handleSubmit} className="rounded-full">
        Submit
      </Button>
    </div>
  );
}
