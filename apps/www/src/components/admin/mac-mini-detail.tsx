"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { usePageBreadcrumbs } from "@/hooks/usePageBreadcrumbs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  drainMacMiniWorker,
  bringMacMiniOnline,
  setMacMiniMaintenance,
  removeMacMiniWorker,
} from "@/server-actions/admin/mac-mini";
import { format } from "date-fns";

type WorkerStatus = "online" | "offline" | "draining" | "maintenance";

interface Allocation {
  id: string;
  workerId: string;
  sandboxId: string;
  threadId: string | null;
  status: "running" | "paused" | "stopped";
  createdAt: Date;
  updatedAt: Date;
}

interface Worker {
  id: string;
  name: string;
  hostname: string;
  port: number;
  status: WorkerStatus;
  maxConcurrentSandboxes: number;
  currentSandboxCount: number;
  lastHealthCheckAt: Date | null;
  lastHealthCheckSuccess: boolean | null;
  consecutiveHealthFailures: number;
  cpuCores: number | null;
  memoryGB: number | null;
  osVersion: string | null;
  openSandboxVersion: string | null;
  dockerVersion: string | null;
  createdAt: Date;
  updatedAt: Date;
  allocations: Allocation[];
}

function statusBadge(status: WorkerStatus) {
  const variants: Record<WorkerStatus, { label: string; className: string }> = {
    online: {
      label: "Online",
      className: "bg-green-100 text-green-800 border-green-200",
    },
    offline: {
      label: "Offline",
      className: "bg-red-100 text-red-800 border-red-200",
    },
    draining: {
      label: "Draining",
      className: "bg-yellow-100 text-yellow-800 border-yellow-200",
    },
    maintenance: {
      label: "Maintenance",
      className: "bg-gray-100 text-gray-700 border-gray-200",
    },
  };
  const v = variants[status] ?? variants.offline;
  return (
    <Badge variant="outline" className={v.className}>
      {v.label}
    </Badge>
  );
}

function allocationStatusBadge(status: "running" | "paused" | "stopped") {
  const variants = {
    running: "bg-green-100 text-green-800 border-green-200",
    paused: "bg-yellow-100 text-yellow-800 border-yellow-200",
    stopped: "bg-gray-100 text-gray-700 border-gray-200",
  };
  return (
    <Badge variant="outline" className={variants[status]}>
      {status}
    </Badge>
  );
}

export function MacMiniDetail({ worker: initialWorker }: { worker: Worker }) {
  usePageBreadcrumbs([
    { label: "Admin", href: "/internal/admin" },
    { label: "Mac Mini Workers", href: "/internal/admin/mac-minis" },
    { label: initialWorker.name },
  ]);

  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const worker = initialWorker;

  function refresh() {
    router.refresh();
  }

  function handleDrain() {
    startTransition(async () => {
      setError(null);
      await drainMacMiniWorker(worker.id);
      refresh();
    });
  }

  function handleBringOnline() {
    startTransition(async () => {
      setError(null);
      const result = await bringMacMiniOnline(worker.id);
      if (!result.success) {
        setError("Worker health check failed — could not bring online.");
      }
      refresh();
    });
  }

  function handleMaintenance() {
    startTransition(async () => {
      setError(null);
      await setMacMiniMaintenance(worker.id);
      refresh();
    });
  }

  function handleRemove() {
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    startTransition(async () => {
      setError(null);
      try {
        await removeMacMiniWorker(worker.id);
        router.push("/internal/admin/mac-minis");
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to remove worker",
        );
        setConfirmRemove(false);
      }
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">{worker.name}</h1>
          <p className="text-muted-foreground mt-1 font-mono text-sm">
            {worker.hostname}:{worker.port}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {worker.status !== "draining" && (
            <Button
              variant="outline"
              disabled={isPending}
              onClick={handleDrain}
            >
              Drain
            </Button>
          )}
          {worker.status !== "online" && (
            <Button
              variant="outline"
              disabled={isPending}
              onClick={handleBringOnline}
            >
              Bring Online
            </Button>
          )}
          {worker.status !== "maintenance" && (
            <Button
              variant="outline"
              disabled={isPending}
              onClick={handleMaintenance}
            >
              Set Maintenance
            </Button>
          )}
          <Button
            variant={confirmRemove ? "destructive" : "outline"}
            disabled={isPending}
            onClick={handleRemove}
            onBlur={() => setConfirmRemove(false)}
          >
            {confirmRemove ? "Confirm Remove?" : "Remove"}
          </Button>
        </div>
      </div>

      {error && (
        <p className="text-sm text-red-600 border border-red-200 bg-red-50 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Status</span>
              {statusBadge(worker.status)}
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Sandboxes</span>
              <span>
                {worker.currentSandboxCount} / {worker.maxConcurrentSandboxes}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Last Health Check</span>
              <span>
                {worker.lastHealthCheckAt
                  ? format(worker.lastHealthCheckAt, "MMM d, yyyy h:mm a")
                  : "Never"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Health Success</span>
              <span>
                {worker.lastHealthCheckSuccess === null
                  ? "—"
                  : worker.lastHealthCheckSuccess
                    ? "Yes"
                    : "No"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">
                Consecutive Failures
              </span>
              <span>{worker.consecutiveHealthFailures}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Hardware</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">CPU Cores</span>
              <span>{worker.cpuCores ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Memory</span>
              <span>
                {worker.memoryGB != null ? `${worker.memoryGB} GB` : "—"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">OS Version</span>
              <span>{worker.osVersion ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">OpenSandbox Version</span>
              <span>{worker.openSandboxVersion ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Docker Version</span>
              <span>{worker.dockerVersion ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Registered</span>
              <span>{format(worker.createdAt, "MMM d, yyyy")}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-3">
          Sandbox Allocations ({worker.allocations.length})
        </h2>
        {worker.allocations.length === 0 ? (
          <p className="text-sm text-muted-foreground border rounded-lg p-6 text-center">
            No active allocations
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sandbox ID</TableHead>
                <TableHead>Thread ID</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created At</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {worker.allocations.map((alloc) => (
                <TableRow key={alloc.id}>
                  <TableCell className="font-mono text-xs">
                    {alloc.sandboxId}
                  </TableCell>
                  <TableCell>
                    {alloc.threadId ? (
                      <Link
                        href={`/internal/admin/thread/${alloc.threadId}`}
                        className="underline font-mono text-xs"
                      >
                        {alloc.threadId}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>{allocationStatusBadge(alloc.status)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {format(alloc.createdAt, "MMM d, yyyy h:mm a")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
