import { describe, expect, it } from "vitest";
import {
  normalizeGitRemoteUrl,
  projectIdForDirectory,
  projectIdForRepository,
  repositoryIdentityFor,
} from "./project";

describe("projectIdForDirectory", () => {
  it("pins the canonical prj_ scheme both adapters share", () => {
    expect(projectIdForDirectory("/home/dev-aluminate/dev/echo-spike-scratch")).toBe(
      "prj_5ef618c8aaeef739",
    );
  });

  it("yields distinct 16-hex ids for distinct inputs", () => {
    const first = projectIdForDirectory("/repo");
    const second = projectIdForDirectory("/repo/sub");
    expect(first).toMatch(/^prj_[0-9a-f]{16}$/);
    expect(second).toMatch(/^prj_[0-9a-f]{16}$/);
    expect(first).not.toBe(second);
    expect(projectIdForDirectory("/repo")).toBe(first);
  });

  it("normalizes equivalent remotes to one identity", () => {
    const https = normalizeGitRemoteUrl("https://github.com/example/echo.git");
    const ssh = normalizeGitRemoteUrl("git@github.com:example/echo.git");
    const credentialed = normalizeGitRemoteUrl("https://user:secret@github.com:443/example/echo/");
    expect(https).toBe("github.com/example/echo");
    expect(ssh).toBe(https);
    expect(credentialed).toBe(https);
  });

  it("keeps a non-default port as a distinct remote", () => {
    expect(normalizeGitRemoteUrl("ssh://git@example.com:2222/team/repo.git")).toBe(
      "example.com:2222/team/repo",
    );
  });

  it("treats a Windows drive path as local, not as a remote host", () => {
    expect(normalizeGitRemoteUrl("C:/repos/echo")).toBe("C:/repos/echo");
  });

  it("joins one repository across root and subdirectory inputs", () => {
    const identity = repositoryIdentityFor({
      directory: "/repo/sub",
      canonicalRoot: "/repo",
      remoteUrl: "git@github.com:example/echo.git",
    });
    expect(identity).toEqual({
      canonicalRoot: "/repo",
      remoteUrl: "github.com/example/echo",
      projectId: projectIdForRepository({
        canonicalRoot: "/repo",
        remoteUrl: "git@github.com:example/echo.git",
      }),
    });
  });

  it("falls back to the canonical root when no remote is registered", () => {
    const identity = repositoryIdentityFor({ directory: "/repo/sub", canonicalRoot: "/repo" });
    expect(identity.remoteUrl).toBeNull();
    expect(identity.projectId).toBe(projectIdForDirectory("/repo"));
  });
});
