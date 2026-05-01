"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useDebouncedCallback } from "use-debounce";
import { Search } from "lucide-react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { searchUsers } from "@/server-actions/admin/user";
import { User } from "better-auth";

export function UserSearch({
  onSelectUser,
}: {
  onSelectUser: (user: User) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [searchResultQuery, setSearchResultQuery] = useState("");
  const [searchResults, setSearchResults] = useState<
    {
      value: User;
      label: string;
    }[]
  >([]);
  const updateSearchResultsDebounced = useDebouncedCallback(
    useCallback(async (query: string) => {
      try {
        setIsLoading(true);
        if (query.trim()) {
          const results = await searchUsers(query);
          setSearchResults(
            results.map((user) => ({
              value: user,
              label: `${user.name} (${user.email})`,
            })),
          );
          setSearchResultQuery(query);
          return;
        }
        setSearchResults([]);
        setSearchResultQuery("");
      } finally {
        setIsLoading(false);
      }
    }, []),
    500,
  );
  useEffect(() => {
    updateSearchResultsDebounced(query);
  }, [query, updateSearchResultsDebounced]);

  const emptyStr = useMemo(() => {
    if (isLoading || (query.trim() && searchResultQuery !== query)) {
      return "Searching...";
    }
    return "No results found.";
  }, [isLoading, query, searchResultQuery]);

  const placeholder = "Search users by name, email, or id...";

  return (
    <>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-mid-text"
          aria-hidden
        />
        <Input
          placeholder={placeholder}
          readOnly
          onFocus={() => {
            setOpen(true);
          }}
          className="pl-11"
        />
      </div>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={placeholder}
          />
          <CommandList>
            <CommandEmpty>{emptyStr}</CommandEmpty>
            {searchResults.map((result) => (
              <CommandItem
                key={result.label}
                onSelect={() => {
                  onSelectUser(result.value);
                  setOpen(false);
                }}
              >
                <span className="px-2 truncate">{result.label}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
