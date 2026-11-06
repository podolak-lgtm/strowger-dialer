import { SectionShell } from "@/components/section-shell";

export default function Layout({ children }: LayoutProps<"/refer">) {
  return <SectionShell section="billing">{children}</SectionShell>;
}
