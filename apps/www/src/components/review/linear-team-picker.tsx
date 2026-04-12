"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { getLinearTeamsAction } from "@/server-actions/review-linear";
import { unwrapResult } from "@/lib/server-actions";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const LAST_TEAM_KEY = "terragon:review:linear-team-id";

interface LinearTeamPickerProps {
  /** Called when the user selects a team. */
  onTeamSelect: (teamId: string) => void;
  /** Optional className for the root element. */
  className?: string;
}

/**
 * Dropdown that fetches the user's Linear teams and lets them pick one.
 * Remembers the last-selected team in localStorage.
 */
export function LinearTeamPicker({
  onTeamSelect,
  className,
}: LinearTeamPickerProps) {
  const {
    data: teams,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["linear-teams"],
    queryFn: async () => {
      const result = await getLinearTeamsAction();
      return unwrapResult(result);
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
  });

  // Determine initial value from localStorage
  const [selectedTeamId, setSelectedTeamId] = React.useState<
    string | undefined
  >(() => {
    if (typeof window === "undefined") return undefined;
    return localStorage.getItem(LAST_TEAM_KEY) ?? undefined;
  });

  // If teams loaded and no selection (or stale selection), auto-select first
  React.useEffect(() => {
    if (!teams || teams.length === 0) return;

    const currentValid = teams.some((t) => t.id === selectedTeamId);
    if (!currentValid) {
      const firstTeam = teams[0]!;
      setSelectedTeamId(firstTeam.id);
      onTeamSelect(firstTeam.id);
      localStorage.setItem(LAST_TEAM_KEY, firstTeam.id);
    } else if (selectedTeamId) {
      // Notify parent of the restored selection
      onTeamSelect(selectedTeamId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teams]);

  function handleValueChange(teamId: string) {
    setSelectedTeamId(teamId);
    onTeamSelect(teamId);
    localStorage.setItem(LAST_TEAM_KEY, teamId);
  }

  if (isLoading) {
    return (
      <div className={className}>
        <Select disabled>
          <SelectTrigger size="sm">
            <SelectValue placeholder="Loading teams..." />
          </SelectTrigger>
        </Select>
      </div>
    );
  }

  if (isError || !teams || teams.length === 0) {
    return (
      <div className={className}>
        <Select disabled>
          <SelectTrigger size="sm">
            <SelectValue placeholder="No teams available" />
          </SelectTrigger>
        </Select>
      </div>
    );
  }

  return (
    <div className={className}>
      <Select value={selectedTeamId} onValueChange={handleValueChange}>
        <SelectTrigger size="sm">
          <SelectValue placeholder="Select a Linear team" />
        </SelectTrigger>
        <SelectContent>
          {teams.map((team) => (
            <SelectItem key={team.id} value={team.id}>
              {team.key} - {team.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
