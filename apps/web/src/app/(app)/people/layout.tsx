import { SectionShell } from "@/components/section-shell";

export default function Layout({ children }: LayoutProps<"/people">) {
  return <SectionShell section="people">{children}</SectionShell>;
}
