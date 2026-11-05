"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { confirmLeave } from "@/lib/leave-guard";

/** A Link that asks first when the page holds unsaved changes (lib/leave-guard.ts). */
export function NavLink(props: ComponentProps<typeof Link>) {
  const { onNavigate, ...rest } = props;
  return (
    <Link
      {...rest}
      onNavigate={(e) => {
        if (!confirmLeave()) {
          e.preventDefault();
          return;
        }
        onNavigate?.(e);
      }}
    />
  );
}
