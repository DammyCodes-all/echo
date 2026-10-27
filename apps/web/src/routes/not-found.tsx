import { Link } from "react-router";
import { ScaffoldPage } from "../components/scaffold-page";

export function NotFoundPage() {
  return (
    <ScaffoldPage
      eyebrow="404"
      title="Nothing on this route"
      description="The page does not exist, or it is not part of the current scaffold."
    >
      <Link
        to="/"
        className="inline-flex rounded-dusk-code border border-dusk-hairline-strong px-3 py-1.5 text-sm text-dusk-muted transition-colors hover:border-dusk-deadend hover:text-dusk-ink"
      >
        Back to projects
      </Link>
    </ScaffoldPage>
  );
}
