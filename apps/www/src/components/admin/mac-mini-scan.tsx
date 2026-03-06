"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { usePageBreadcrumbs } from "@/hooks/usePageBreadcrumbs";
import { addMacMiniWorker } from "@/server-actions/admin/mac-mini";

interface QRPayload {
  name: string;
  tailscaleIp: string;
  port: number;
  apiKey: string;
  osVersion?: string;
  cpuCores?: number;
  memoryGB?: number;
}

function parseQRPayload(raw: string): QRPayload | null {
  try {
    const data = JSON.parse(raw);
    if (
      typeof data.name === "string" &&
      typeof data.tailscaleIp === "string" &&
      typeof data.port === "number" &&
      typeof data.apiKey === "string"
    ) {
      return data as QRPayload;
    }
    return null;
  } catch {
    return null;
  }
}

function parsePayloadFromSearchParams(
  params: URLSearchParams,
): QRPayload | null {
  const name = params.get("name")?.trim();
  const tailscaleIp = params.get("tailscaleIp")?.trim();
  const apiKey = params.get("apiKey")?.trim();
  const portValue = params.get("port");
  const port = portValue ? Number(portValue) : NaN;

  if (!name || !tailscaleIp || !apiKey || !Number.isFinite(port)) {
    return null;
  }

  const payload: QRPayload = {
    name,
    tailscaleIp,
    apiKey,
    port,
  };

  const osVersion = params.get("osVersion")?.trim();
  if (osVersion) {
    payload.osVersion = osVersion;
  }

  const cpuCoresValue = params.get("cpuCores");
  if (cpuCoresValue) {
    const cpuCores = Number(cpuCoresValue);
    if (Number.isFinite(cpuCores)) {
      payload.cpuCores = cpuCores;
    }
  }

  const memoryGBValue = params.get("memoryGB");
  if (memoryGBValue) {
    const memoryGB = Number(memoryGBValue);
    if (Number.isFinite(memoryGB)) {
      payload.memoryGB = memoryGB;
    }
  }

  return payload;
}

function ConfirmCard({
  payload,
  onCancel,
  onConfirm,
  isPending,
  error,
}: {
  payload: QRPayload;
  onCancel: () => void;
  onConfirm: () => void;
  isPending: boolean;
  error: string | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Confirm Worker Registration</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2 text-sm">
          <div className="flex justify-between border-b pb-2">
            <span className="text-muted-foreground">Name</span>
            <span className="font-medium">{payload.name}</span>
          </div>
          <div className="flex justify-between border-b pb-2">
            <span className="text-muted-foreground">Tailscale IP</span>
            <span className="font-mono">{payload.tailscaleIp}</span>
          </div>
          <div className="flex justify-between border-b pb-2">
            <span className="text-muted-foreground">Port</span>
            <span className="font-mono">{payload.port}</span>
          </div>
          {payload.osVersion && (
            <div className="flex justify-between border-b pb-2">
              <span className="text-muted-foreground">OS Version</span>
              <span>{payload.osVersion}</span>
            </div>
          )}
          {payload.cpuCores != null && (
            <div className="flex justify-between border-b pb-2">
              <span className="text-muted-foreground">CPU Cores</span>
              <span>{payload.cpuCores}</span>
            </div>
          )}
          {payload.memoryGB != null && (
            <div className="flex justify-between border-b pb-2">
              <span className="text-muted-foreground">Memory</span>
              <span>{payload.memoryGB} GB</span>
            </div>
          )}
        </div>
        {error && (
          <p className="text-sm text-red-600 border border-red-200 bg-red-50 rounded-md px-3 py-2">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button variant="outline" onClick={onCancel} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={isPending}>
            {isPending ? "Registering..." : "Register Worker"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function CameraScanner({ onDetected }: { onDetected: (raw: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    let active = true;

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        if (!active) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setScanning(true);
        scan();
      } catch (err) {
        setCameraError("Camera access denied or unavailable.");
      }
    }

    function scan() {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || !active) return;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      if (canvas.width > 0 && canvas.height > 0) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        const detector = (window as any).BarcodeDetector;
        if (detector) {
          new detector({ formats: ["qr_code"] })
            .detect(imageData)
            .then((barcodes: any[]) => {
              if (barcodes.length > 0 && active) {
                onDetected(barcodes[0].rawValue);
              } else {
                rafRef.current = requestAnimationFrame(scan);
              }
            })
            .catch(() => {
              rafRef.current = requestAnimationFrame(scan);
            });
        } else {
          // BarcodeDetector not available — stop and let the fallback show
          setCameraError("BarcodeDetector API not supported in this browser.");
        }
      } else {
        rafRef.current = requestAnimationFrame(scan);
      }
    }

    start();

    return () => {
      active = false;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [onDetected]);

  if (cameraError) {
    return (
      <p className="text-sm text-red-600 border border-red-200 bg-red-50 rounded-md px-3 py-2">
        {cameraError}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="relative rounded-lg overflow-hidden bg-black aspect-video w-full max-w-md mx-auto">
        <video
          ref={videoRef}
          className="w-full h-full object-cover"
          playsInline
          muted
        />
        {/* Scanning overlay */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="border-2 border-white/60 rounded-lg w-48 h-48" />
        </div>
      </div>
      {/* Hidden canvas used for frame capture */}
      <canvas ref={canvasRef} className="hidden" />
      {scanning && (
        <p className="text-sm text-center text-muted-foreground animate-pulse">
          Scanning for QR code...
        </p>
      )}
    </div>
  );
}

function ManualFallback({
  onParsed,
}: {
  onParsed: (payload: QRPayload) => void;
}) {
  const [value, setValue] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);

  function handleSubmit() {
    const payload = parseQRPayload(value.trim());
    if (!payload) {
      setParseError(
        "Invalid JSON. Expected: { name, tailscaleIp, port, apiKey, osVersion?, cpuCores?, memoryGB? }",
      );
      return;
    }
    setParseError(null);
    onParsed(payload);
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Paste the worker JSON payload below:
      </p>
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder='{"name":"mac-mini-01","tailscaleIp":"100.64.1.5","port":8080,"apiKey":"..."}'
        rows={6}
        className="font-mono text-xs"
      />
      {parseError && (
        <p className="text-sm text-red-600 border border-red-200 bg-red-50 rounded-md px-3 py-2">
          {parseError}
        </p>
      )}
      <Button onClick={handleSubmit} disabled={!value.trim()}>
        Parse and Continue
      </Button>
    </div>
  );
}

export function MacMiniScan() {
  usePageBreadcrumbs([
    { label: "Admin", href: "/internal/admin" },
    { label: "Mac Mini Workers", href: "/internal/admin/mac-minis" },
    { label: "Pair New Worker" },
  ]);

  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [payload, setPayload] = useState<QRPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [useManual, setUseManual] = useState(false);

  // Check if BarcodeDetector is available at render time
  const barcodeDetectorAvailable =
    typeof window !== "undefined" && "BarcodeDetector" in window;

  useEffect(() => {
    if (payload) {
      return;
    }
    const parsed = parsePayloadFromSearchParams(searchParams);
    if (parsed) {
      setPayload(parsed);
    }
  }, [searchParams, payload]);

  function handleDetected(raw: string) {
    const parsed = parseQRPayload(raw);
    if (parsed) {
      setPayload(parsed);
    }
  }

  function handleRegister() {
    if (!payload) return;
    startTransition(async () => {
      setError(null);
      try {
        await addMacMiniWorker({
          name: payload.name,
          hostname: payload.tailscaleIp,
          port: payload.port,
          apiKey: payload.apiKey,
          osVersion: payload.osVersion,
          cpuCores: payload.cpuCores,
          memoryGB: payload.memoryGB,
        });
        router.push("/internal/admin/mac-minis");
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to register worker",
        );
      }
    });
  }

  if (payload) {
    return (
      <div className="max-w-lg space-y-6">
        <h1 className="text-3xl font-bold">Pair New Mac Mini Worker</h1>
        <ConfirmCard
          payload={payload}
          onCancel={() => setPayload(null)}
          onConfirm={handleRegister}
          isPending={isPending}
          error={error}
        />
      </div>
    );
  }

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Pair New Mac Mini Worker</h1>
        <p className="text-muted-foreground mt-1">
          Scan the QR code displayed on the worker or paste the JSON payload.
        </p>
      </div>

      {!useManual && barcodeDetectorAvailable ? (
        <Card>
          <CardContent className="pt-6 space-y-4">
            <CameraScanner onDetected={handleDetected} />
            <div className="text-center">
              <button
                className="text-sm text-muted-foreground underline"
                onClick={() => setUseManual(true)}
              >
                Can't scan? Enter JSON manually
              </button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Paste Worker JSON</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <ManualFallback onParsed={setPayload} />
            {barcodeDetectorAvailable && (
              <div className="text-center">
                <button
                  className="text-sm text-muted-foreground underline"
                  onClick={() => setUseManual(false)}
                >
                  Use camera instead
                </button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
