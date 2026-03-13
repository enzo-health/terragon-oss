export function ImagePart({
  imageUrl,
  alt,
  onClick,
}: {
  imageUrl: string;
  alt?: string;
  onClick?: () => void;
}) {
  return (
    <img
      src={imageUrl}
      alt={alt || "Image"}
      loading="lazy"
      className="max-w-[200px] cursor-pointer"
      onClick={onClick}
    />
  );
}
