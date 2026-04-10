import { ThreadVisibility } from "@leo/shared";
import { Lock, Globe, Users } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAtomValue } from "jotai";
import { userSettingsAtom, useUpdateUserSettingsMutation } from "@/atoms/user";

export function ThreadVisibilitySelector() {
  const userSettings = useAtomValue(userSettingsAtom);
  const userSettingsMutation = useUpdateUserSettingsMutation();

  const getIcon = (visibility: ThreadVisibility) => {
    switch (visibility) {
      case "private":
        return <Lock className="h-3 w-3" />;
      case "link":
        return <Globe className="h-3 w-3" />;
      case "repo":
        return <Users className="h-3 w-3" />;
      default:
        const _exhaustiveCheck: never = visibility;
        return _exhaustiveCheck;
    }
  };

  const getLabel = (visibility: ThreadVisibility) => {
    switch (visibility) {
      case "private":
        return "Private";
      case "link":
        return "Logged in users with the link";
      case "repo":
        return "Repository members";
      default:
        const _exhaustiveCheck: never = visibility;
        return _exhaustiveCheck;
    }
  };

  return (
    <Select
      value={userSettings?.defaultThreadVisibility}
      onValueChange={async (value) => {
        await userSettingsMutation.mutateAsync({
          defaultThreadVisibility: value as ThreadVisibility,
        });
      }}
    >
      <SelectTrigger className="w-fit">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(["private", "link", "repo"] as ThreadVisibility[]).map((vis) => (
          <SelectItem key={vis} value={vis}>
            <div className="flex items-center gap-2">
              {getIcon(vis)}
              <span>{getLabel(vis)}</span>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
