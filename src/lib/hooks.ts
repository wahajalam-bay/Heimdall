"use client";

import { useEffect, useLayoutEffect } from "react";

/**
 * `useLayoutEffect` on the client, `useEffect` on the server.
 *
 * Client components are rendered on the server too, where a layout effect cannot
 * run — this keeps measurement before paint in the browser without asking the
 * server renderer for something it cannot give.
 */
export const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
