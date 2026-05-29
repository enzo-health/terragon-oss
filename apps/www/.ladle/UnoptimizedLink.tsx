import React from "react";

type UnoptimizedLinkProps = React.ComponentPropsWithoutRef<"a">;

const UnoptimizedLink = ({ children, ...props }: UnoptimizedLinkProps) => {
  return <a {...props}>{children}</a>;
};

export default UnoptimizedLink;
