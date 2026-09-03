#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const MANAGED_PREFIX = "canopy-";
const CONFIG_KEYS = [
  "ARBOR_RAILWAY_SERVICE",
  "ARBOR_RAILWAY_REPO",
  "ARBOR_RAILWAY_BRANCH",
  "ARBOR_DOMAIN",
  "ARBOR_COMMUNITY_HANDLE",
  "ARBOR_FIRST_WRITER_HANDLE",
] as const;

type ConfigKey = typeof CONFIG_KEYS[number];
export type CanopyDeploymentConfig = Record<ConfigKey, string>;

interface RailwayStatus {
  id: string;
  name: string;
  environments: { edges: Array<{ node: RailwayEnvironment }> };
}

interface RailwayEnvironment {
  id: string;
  name: string;
  serviceInstances: { edges: Array<{ node: RailwayServiceInstance }> };
  volumeInstances: { edges: Array<{ node: RailwayVolumeInstance }> };
}

interface RailwayServiceInstance {
  serviceId: string;
  serviceName: string;
  source?: { repo?: string | null } | null;
  latestDeployment?: { status?: string } | null;
  domains?: {
    customDomains?: Array<{ domain: string; id: string }>;
    serviceDomains?: Array<{ domain: string; id: string }>;
  };
}

interface RailwayVolumeInstance {
  id: string;
  serviceId: string;
  mountPath: string;
  state: string;
  volume: { id: string; name: string };
}

function usage(): never {
  console.error(`Usage:
  bun run canopy:railway apply <deploy/canopies/name.env>
  bun run canopy:railway status [deploy/canopies/name.env]
  bun run canopy:railway destroy <deploy/canopies/name.env> --yes`);
  process.exit(2);
}

function value(source: string, key: string): string | undefined {
  const line = source.split(/\r?\n/).find((candidate) => candidate.trim().startsWith(`${key}=`));
  if (!line) return undefined;
  const raw = line.slice(line.indexOf("=") + 1).trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) return raw.slice(1, -1);
  return raw;
}

export function parseCanopyDeploymentConfig(source: string): CanopyDeploymentConfig {
  const result = Object.fromEntries(CONFIG_KEYS.map((key) => [key, value(source, key)])) as Partial<CanopyDeploymentConfig>;
  const missing = CONFIG_KEYS.filter((key) => !result[key]);
  if (missing.length) throw new Error(`Canopy deployment config is missing: ${missing.join(", ")}`);
  for (const line of source.split(/\r?\n/)) {
    const key = /^\s*([A-Z0-9_]+)=/.exec(line)?.[1];
    if (key && !CONFIG_KEYS.includes(key as ConfigKey)) throw new Error(`Unsupported Canopy deployment setting: ${key}`);
  }
  if (!result.ARBOR_RAILWAY_SERVICE!.startsWith(MANAGED_PREFIX) || result.ARBOR_RAILWAY_SERVICE!.length > 32) {
    throw new Error(`Managed Railway service names must start with ${MANAGED_PREFIX} and be at most 32 characters`);
  }
  if (!/^[a-z0-9.-]+$/.test(result.ARBOR_DOMAIN!) || new URL(`https://${result.ARBOR_DOMAIN}`).hostname !== result.ARBOR_DOMAIN) {
    throw new Error("ARBOR_DOMAIN must be a bare lowercase hostname");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(result.ARBOR_COMMUNITY_HANDLE!)
    || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(result.ARBOR_FIRST_WRITER_HANDLE!)) {
    throw new Error("Canopy handles must be lowercase letters, digits, or hyphens");
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(result.ARBOR_RAILWAY_REPO!)) throw new Error("ARBOR_RAILWAY_REPO must be owner/repo");
  return result as CanopyDeploymentConfig;
}

async function command(program: string, args: string[], options: { json?: boolean } = {}): Promise<any> {
  const child = Bun.spawn([program, ...args], {
    cwd: resolve(import.meta.dir, ".."),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exit !== 0) throw new Error(stderr.trim() || `${program} ${args[0] ?? ""} failed`);
  if (!options.json) return stdout.trim();
  try { return JSON.parse(stdout); }
  catch { throw new Error(`${program} returned invalid JSON: ${stdout.trim()}`); }
}

async function railway(args: string[]): Promise<any> {
  return command("railway", [...args, "--json"], { json: true });
}

async function configureRuntime(environment: RailwayEnvironment, instance: RailwayServiceInstance): Promise<void> {
  const query = "mutation ConfigureCanopy($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }";
  const variables = JSON.stringify({
    serviceId: instance.serviceId,
    environmentId: environment.id,
    input: {
      dockerfilePath: "/Dockerfile.canopy",
      startCommand: "bun run canopyd",
      healthcheckPath: "/",
      healthcheckTimeout: 10,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
    },
  });
  const result = await command("railway", ["api", query, "--variables", variables, "--compact"], { json: true }) as {
    data?: { serviceInstanceUpdate?: boolean };
    errors?: Array<{ message?: string }>;
  };
  if (result.errors?.length || result.data?.serviceInstanceUpdate !== true) {
    throw new Error(result.errors?.[0]?.message ?? `Railway did not configure ${instance.serviceName}`);
  }
}

async function status(): Promise<RailwayStatus> {
  return railway(["status"]);
}

function production(project: RailwayStatus): RailwayEnvironment {
  const environment = project.environments.edges.map((edge) => edge.node).find((candidate) => candidate.name === "production");
  if (!environment) throw new Error(`Railway project ${project.name} has no production environment`);
  return environment;
}

function service(environment: RailwayEnvironment, name: string): RailwayServiceInstance | undefined {
  return environment.serviceInstances.edges.map((edge) => edge.node).find((candidate) => candidate.serviceName === name);
}

function managed(environment: RailwayEnvironment): RailwayServiceInstance[] {
  return environment.serviceInstances.edges.map((edge) => edge.node)
    .filter((candidate) => candidate.serviceName.startsWith(MANAGED_PREFIX))
    .sort((left, right) => left.serviceName.localeCompare(right.serviceName));
}

async function config(path: string): Promise<CanopyDeploymentConfig> {
  return parseCanopyDeploymentConfig(await readFile(resolve(path), "utf8"));
}

async function requirePublished(config: CanopyDeploymentConfig): Promise<void> {
  const [head, remote] = await Promise.all([
    command("git", ["rev-parse", "HEAD"]),
    command("git", ["rev-parse", `origin/${config.ARBOR_RAILWAY_BRANCH}`]),
  ]);
  if (head !== remote) {
    throw new Error(`HEAD is not published at origin/${config.ARBOR_RAILWAY_BRANCH}; push the verified deployment revision first`);
  }
}

export function dnsLines(value: unknown): string[] {
  const lines: string[] = [];
  const visit = (candidate: unknown) => {
    if (!candidate || typeof candidate !== "object") return;
    const record = candidate as Record<string, unknown>;
    const rawType = typeof record.type === "string" ? record.type : typeof record.recordType === "string" ? record.recordType : undefined;
    const type = rawType?.replace("DNS_RECORD_TYPE_", "");
    const name = typeof record.name === "string"
      ? record.name
      : typeof record.host === "string"
        ? record.host
        : typeof record.dnsHost === "string"
          ? record.dnsHost
          : undefined;
    const content = typeof record.value === "string"
      ? record.value
      : typeof record.target === "string"
        ? record.target
        : typeof record.requiredValue === "string"
          ? record.requiredValue
          : typeof record.token === "string"
            ? record.token
            : undefined;
    const inferredType = type ?? (typeof record.dnsHost === "string" && typeof record.token === "string" ? "TXT" : undefined);
    if (inferredType && name && content) lines.push(`${inferredType} ${name} ${content}`);
    for (const child of Object.values(record)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") visit(child);
    }
  };
  visit(value);
  return [...new Set(lines)];
}

async function showDomain(project: RailwayStatus, environment: RailwayEnvironment, instance: RailwayServiceInstance, domain: string): Promise<void> {
  const details = await railway([
    "domain", "status", domain,
    "--service", instance.serviceId,
    "--environment", environment.id,
    "--project", project.id,
  ]);
  console.log(`Domain: https://${domain}`);
  const records = dnsLines(details);
  if (records.length) {
    console.log("DNS records to add at your DNS provider:");
    for (const record of records) console.log(`  ${record}`);
  } else {
    console.log("DNS records are not exposed by this Railway CLI response; inspect the domain in Railway.");
  }
  const domainDetails = (details as { domain?: { verification?: { verified?: boolean }; certificate?: { status?: string } } }).domain;
  const ready = domainDetails?.verification?.verified === true
    || domainDetails?.certificate?.status === "CERTIFICATE_STATUS_TYPE_ISSUED";
  console.log(`DNS status: ${ready ? "verified or issuing" : "waiting for DNS"}`);
}

async function apply(configPath: string): Promise<void> {
  const desired = await config(configPath);
  await requirePublished(desired);
  let project = await status();
  let environment = production(project);
  let instance = service(environment, desired.ARBOR_RAILWAY_SERVICE);
  if (!instance) {
    await railway(["add", "--service", desired.ARBOR_RAILWAY_SERVICE]);
    project = await status();
    environment = production(project);
    instance = service(environment, desired.ARBOR_RAILWAY_SERVICE);
    if (!instance) throw new Error(`Railway did not create ${desired.ARBOR_RAILWAY_SERVICE}`);
    console.log(`Created Railway service ${instance.serviceName}.`);
  }

  const volumes = environment.volumeInstances.edges.map((edge) => edge.node).filter((candidate) => candidate.serviceId === instance!.serviceId);
  if (volumes.length > 1) throw new Error(`${instance.serviceName} has several volumes; refusing to guess`);
  if (!volumes.length) {
    await railway([
      "volume", "--service", instance.serviceId,
      "--environment", environment.id,
      "--project", project.id,
      "add", "--mount-path", "/data",
    ]);
    console.log("Attached a fresh Railway volume at /data.");
  } else if (volumes[0]!.mountPath !== "/data") {
    throw new Error(`${instance.serviceName} volume is mounted at ${volumes[0]!.mountPath}, not /data`);
  }

  await railway([
    "variable", "set",
    `ARBOR_DOMAIN=${desired.ARBOR_DOMAIN}`,
    `ARBOR_COMMUNITY_HANDLE=${desired.ARBOR_COMMUNITY_HANDLE}`,
    `ARBOR_FIRST_WRITER_HANDLE=${desired.ARBOR_FIRST_WRITER_HANDLE}`,
    "--skip-deploys",
    "--service", instance.serviceId,
    "--environment", environment.id,
    "--project", project.id,
  ]);
  await configureRuntime(environment, instance);

  const domains = await railway([
    "domain", "list",
    "--service", instance.serviceId,
    "--environment", environment.id,
    "--project", project.id,
  ]) as { domains?: Array<{ domain: string }>; customDomains?: Array<{ domain: string }> } | Array<{ domain?: string }>;
  const domainList = Array.isArray(domains) ? domains : domains.domains ?? domains.customDomains ?? [];
  if (!domainList.some((candidate) => candidate.domain === desired.ARBOR_DOMAIN)) {
    await railway([
      "domain", desired.ARBOR_DOMAIN,
      "--service", instance.serviceId,
      "--environment", environment.id,
      "--project", project.id,
    ]);
    console.log(`Added Railway custom domain ${desired.ARBOR_DOMAIN}.`);
  }

  if (instance.source?.repo !== desired.ARBOR_RAILWAY_REPO) {
    await railway([
      "service", "source", "connect",
      "--repo", desired.ARBOR_RAILWAY_REPO,
      "--branch", desired.ARBOR_RAILWAY_BRANCH,
      "--service", instance.serviceId,
      "--environment", environment.id,
      "--project", project.id,
    ]);
    console.log(`Connected ${instance.serviceName} to ${desired.ARBOR_RAILWAY_REPO}:${desired.ARBOR_RAILWAY_BRANCH}.`);
  }
  project = await status();
  environment = production(project);
  instance = service(environment, desired.ARBOR_RAILWAY_SERVICE)!;
  console.log(`Deployment: ${instance.latestDeployment?.status ?? "pending"}`);
  await showDomain(project, environment, instance, desired.ARBOR_DOMAIN);
}

async function show(configPath?: string): Promise<void> {
  const project = await status();
  const environment = production(project);
  const desired = configPath ? await config(configPath) : undefined;
  const instances = desired ? [service(environment, desired.ARBOR_RAILWAY_SERVICE)].filter(Boolean) as RailwayServiceInstance[] : managed(environment);
  if (!instances.length) {
    console.log(`No ${desired ? desired.ARBOR_RAILWAY_SERVICE : "managed Canopy"} service in ${project.name}/production.`);
    return;
  }
  for (const instance of instances) {
    const volume = environment.volumeInstances.edges.map((edge) => edge.node).find((candidate) => candidate.serviceId === instance.serviceId);
    console.log(`${instance.serviceName}: ${instance.latestDeployment?.status ?? "not deployed"}; volume ${volume ? `${volume.state} at ${volume.mountPath}` : "missing"}`);
    for (const domain of instance.domains?.customDomains ?? []) await showDomain(project, environment, instance, domain.domain);
  }
}

async function destroy(configPath: string, confirmed: boolean): Promise<void> {
  if (!confirmed) throw new Error("Destroy requires --yes; this deletes the Railway service and its persistent volume");
  const desired = await config(configPath);
  const project = await status();
  const environment = production(project);
  const instance = service(environment, desired.ARBOR_RAILWAY_SERVICE);
  if (!instance) {
    console.log(`${desired.ARBOR_RAILWAY_SERVICE} is already absent.`);
    return;
  }
  if (!instance.serviceName.startsWith(MANAGED_PREFIX)) throw new Error("Refusing to delete an unmanaged Railway service");
  const volume = environment.volumeInstances.edges.map((edge) => edge.node).find((candidate) => candidate.serviceId === instance.serviceId);
  await railway([
    "service", "delete",
    "--service", instance.serviceId,
    "--environment", environment.id,
    "--project", project.id,
    "--yes",
  ]);
  if (volume) {
    const remaining = production(await status()).volumeInstances.edges.map((edge) => edge.node)
      .some((candidate) => candidate.volume.id === volume.volume.id);
    if (remaining) {
      await railway([
        "volume", "--project", project.id,
        "--environment", environment.id,
        "delete", "--volume", volume.volume.id, "--yes",
      ]);
    }
  }
  console.log(`Deleted ${instance.serviceName}${volume ? " and its volume" : ""}. Remove its DNS records separately.`);
}

async function main(): Promise<void> {
  const [action, configPath, ...rest] = process.argv.slice(2);
  if (action === "apply" && configPath && !rest.length) return apply(configPath);
  if (action === "status" && (!configPath || !rest.length)) return show(configPath);
  if (action === "destroy" && configPath && rest.every((arg) => arg === "--yes")) return destroy(configPath, rest.includes("--yes"));
  if (action === "help" || action === "--help" || action === "-h") usage();
  usage();
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
