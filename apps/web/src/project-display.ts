function basename(path: string): string {
  const parts = path.split(/[/\\]+/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? path;
}

/** Pretty display name: stored name, else the repo dir, de-slugged and title-cased. */
export function displayProjectName(project: {
  name: string | null;
  root: string;
  id: string;
}): string {
  const raw = (project.name ?? basename(project.root) ?? project.id).trim();
  const words = raw.replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  return words.replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}
