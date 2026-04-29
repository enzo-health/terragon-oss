"use client";

import { useState, useEffect } from "react";
import {
  useAdminBannerQuery,
  useUpdateBannerMutation,
  useDeleteBannerMutation,
} from "@/hooks/use-admin-banner-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { BannerConfig } from "@/lib/banner";

export function BannerAdmin() {
  const { data: bannerConfig, isLoading } = useAdminBannerQuery();
  const updateMutation = useUpdateBannerMutation();
  const deleteMutation = useDeleteBannerMutation();

  const [formData, setFormData] = useState<BannerConfig>({
    message: "",
    variant: "default",
    enabled: false,
  });

  useEffect(() => {
    if (bannerConfig) {
      setFormData(bannerConfig);
    }
  }, [bannerConfig]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    updateMutation.mutate(formData, {
      onSuccess: () => {
        toast.success("Banner configuration updated successfully");
      },
      onError: (error) => {
        toast.error("Failed to update banner: " + error.message);
      },
    });
  };

  const handleDelete = () => {
    if (confirm("Are you sure you want to delete the banner configuration?")) {
      deleteMutation.mutate(undefined, {
        onSuccess: () => {
          toast.success("Banner configuration deleted successfully");
          setFormData({
            message: "",
            variant: "default",
            enabled: false,
          });
        },
        onError: (error) => {
          toast.error("Failed to delete banner: " + error.message);
        },
      });
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  return (
    <div className="container mx-auto py-8 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>Banner Management</CardTitle>
          <CardDescription>
            Configure the top banner that appears across the application
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="enabled">Enable Banner</Label>
              <div className="flex items-center space-x-2">
                <Switch
                  id="enabled"
                  checked={formData.enabled}
                  onCheckedChange={(checked) =>
                    setFormData({ ...formData, enabled: checked })
                  }
                />
                <Label htmlFor="enabled" className="font-normal">
                  {formData.enabled ? "Banner is visible" : "Banner is hidden"}
                </Label>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="message">Banner Message</Label>
              <Textarea
                id="message"
                placeholder="Enter the banner message..."
                value={formData.message}
                onChange={(e) =>
                  setFormData({ ...formData, message: e.target.value })
                }
                rows={3}
                required
              />
            </div>

            <div className="space-y-2">
              <Label>Banner Variant</Label>
              <RadioGroup
                value={formData.variant}
                onValueChange={(value) =>
                  setFormData({
                    ...formData,
                    variant: value as BannerConfig["variant"],
                  })
                }
              >
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="default" id="default" />
                  <Label htmlFor="default" className="font-normal">
                    Default (Neutral information)
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="warning" id="warning" />
                  <Label htmlFor="warning" className="font-normal">
                    Warning (Important updates or potential issues)
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="error" id="error" />
                  <Label htmlFor="error" className="font-normal">
                    Error (Critical alerts or outages)
                  </Label>
                </div>
              </RadioGroup>
            </div>

            {formData.enabled && formData.message && (
              <div className="space-y-2">
                <Label>Preview</Label>
                <div
                  className={`rounded px-4 py-2 text-center text-sm font-medium ${
                    formData.variant === "default"
                      ? "bg-muted text-muted-foreground border border-border"
                      : formData.variant === "warning"
                        ? "bg-warning/10 text-warning border border-warning/30"
                        : "bg-error/10 text-error border border-error/30"
                  }`}
                >
                  {formData.message}
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <Button
                type="submit"
                disabled={updateMutation.isPending || deleteMutation.isPending}
              >
                {updateMutation.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Save Configuration
              </Button>
              {bannerConfig && (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={handleDelete}
                  disabled={
                    updateMutation.isPending || deleteMutation.isPending
                  }
                >
                  {deleteMutation.isPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  Delete Configuration
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
