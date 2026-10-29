import { BookOpen01Icon, DashboardSquare01Icon, Structure01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate } from "react-router";
import { LiquidNavbar } from "./ui/liquid-glass-navbar";

export const PROJECT_SECTIONS = ["overview", "learn", "architecture"] as const;

export function ProjectNavPill({ projectId, active }: { projectId: string; active: number }) {
  const navigate = useNavigate();
  return (
    <div className="fixed right-6 bottom-6 z-50">
      <LiquidNavbar
        tone="dark"
        sound={false}
        active={active}
        onChange={(index) => {
          const section = PROJECT_SECTIONS[index];
          if (section) navigate(`/projects/${projectId}/${section}`);
        }}
        items={[
          {
            label: "Overview",
            icon: <HugeiconsIcon icon={DashboardSquare01Icon} size={18} strokeWidth={1.8} />,
            fx: "glow",
          },
          {
            label: "Learn",
            icon: <HugeiconsIcon icon={BookOpen01Icon} size={18} strokeWidth={1.8} />,
            fx: "spin",
          },
          {
            label: "Architecture",
            icon: <HugeiconsIcon icon={Structure01Icon} size={18} strokeWidth={1.8} />,
            fx: "wave",
          },
        ]}
      />
    </div>
  );
}
