"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { usePageBreadcrumbs } from "@/hooks/usePageBreadcrumbs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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

function WorkerRow({
  worker,
  onMutate,
}: {
  worker: Worker;
  onMutate: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [confirmRemove, setConfirmRemove] = useState(false);

  function handleDrain() {
    startTransition(async () => {
      await drainMacMiniWorker(worker.id);
      onMutate();
    });
  }

  function handleBringOnline() {
    startTransition(async () => {
      await bringMacMiniOnline(worker.id);
      onMutate();
    });
  }

  function handleRemove() {
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    startTransition(async () => {
      try {
        await removeMacMiniWorker(worker.id);
        onMutate();
      } catch (err) {
        alert(err instanceof Error ? err.message : "Failed to remove worker");
        setConfirmRemove(false);
      }
    });
  }

  return (
    <TableRow>
      <TableCell className="font-medium">{worker.name}</TableCell>
      <TableCell className="font-mono text-sm text-muted-foreground">
        {worker.hostname}:{worker.port}
      </TableCell>
      <TableCell>{statusBadge(worker.status)}</TableCell>
      <TableCell className="text-center">
        {worker.currentSandboxCount}/{worker.maxConcurrentSandboxes}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {worker.lastHealthCheckAt
          ? format(worker.lastHealthCheckAt, "MMM d, h:mm a")
          : "Never"}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href={`/internal/admin/mac-minis/${worker.id}`}>View</Link>
          </Button>
          {worker.status !== "draining" && (
            <Button
              variant="outline"
              size="sm"
              disabled={isPending}
              onClick={handleDrain}
            >
              Drain
            </Button>
          )}
          {worker.status !== "online" && (
            <Button
              variant="outline"
              size="sm"
              disabled={isPending}
              onClick={handleBringOnline}
            >
              Bring Online
            </Button>
          )}
          <Button
            variant={confirmRemove ? "destructive" : "outline"}
            size="sm"
            disabled={isPending}
            onClick={handleRemove}
            onBlur={() => setConfirmRemove(false)}
          >
            {confirmRemove ? "Confirm?" : "Remove"}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

export function MacMinisContent({
  workers: initialWorkers,
}: {
  workers: Worker[];
}) {
  usePageBreadcrumbs([
    { label: "Admin", href: "/internal/admin" },
    { label: "Mac Mini Workers" },
  ]);

  const router = useRouter();
  const [workers] = useState(initialWorkers);

  function refresh() {
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Mac Mini Workers</h1>
          <p className="text-muted-foreground mt-1">
            {workers.length} worker{workers.length !== 1 ? "s" : ""} registered
          </p>
        </div>
        <Button asChild>
          <Link href="/internal/admin/mac-minis/scan">Pair</Link>
        </Button>
      </div>

      {workers.length === 0 ? (
        <div className="border rounded-lg p-12 text-center space-y-4">
          <p className="text-muted-foreground text-lg">No workers registered</p>
          <p className="text-sm text-muted-foreground">
            Pair a new Mac Mini worker by scanning its QR code.
          </p>
          <Button asChild>
            <Link href="/internal/admin/mac-minis/scan">Pair</Link>
          </Button>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Hostname</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-center">Sandboxes</TableHead>
              <TableHead>Last Health Check</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {workers.map((worker) => (
              <WorkerRow key={worker.id} worker={worker} onMutate={refresh} />
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
