import { SectionShell } from "@/components/section-shell";

export default function Layout({ children }: LayoutProps<"/billing">) {
  return <SectionShell section="billing">{children}</SectionShell>;
}
