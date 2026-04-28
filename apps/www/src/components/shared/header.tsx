export const headerClassName = "h-14 md:h-[58px]";

// Solid cream header — the brand spec calls for opaque {colors.canvas} on
// nav bars. The previous implementation used backdrop-blur + 82% opacity,
// but content beneath the header is the same canvas color, so the blur
// did no perceptual work. A clean hairline divider does the elevation job.
export const headerSurfaceClassName = "border-b border-hairline bg-background";
