import React from "react";

interface UnoptimizedImageProps
  extends React.ImgHTMLAttributes<HTMLImageElement> {
  fill?: boolean;
}

const UnoptimizedImage: React.FC<UnoptimizedImageProps> = ({
  fill,
  alt = "",
  ...props
}) => {
  const style: React.CSSProperties = fill
    ? {
        position: "absolute",
        inset: "0",
        width: "100%",
        height: "100%",
      }
    : {};

  return React.createElement("img", { ...props, alt, style });
};

export default UnoptimizedImage;
