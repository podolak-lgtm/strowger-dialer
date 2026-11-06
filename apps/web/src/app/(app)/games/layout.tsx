import { SectionShell } from "@/components/section-shell";

export default function Layout({ children }: LayoutProps<"/games">) {
  return <SectionShell section="people">{children}</SectionShell>;
}
