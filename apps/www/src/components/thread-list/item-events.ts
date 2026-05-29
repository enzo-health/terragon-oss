import React from "react";

export const stopLinkEventPropagation = (event: React.MouseEvent) => {
  event.preventDefault();
  event.stopPropagation();
};

export const stopCheckboxClickPropagation = (event: React.MouseEvent) => {
  event.stopPropagation();
};

export const stopTouchEventPropagation = (event: React.TouchEvent) => {
  event.stopPropagation();
};

export const preventDefaultLinkEvent = (
  event: React.MouseEvent | React.PointerEvent,
) => {
  event.preventDefault();
};
