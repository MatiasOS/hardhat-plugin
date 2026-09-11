import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveSourceCode } from "./source-resolver.js";

/**
 * The parts of a solc build info file the explorer reads: compiler version,
 * source language and EVM version.
 */
export interface ExplorerBuildInfo {
  solcVersion?: string;
  solcLongVersion?: string;
  input: {
    language?: string;
    settings: {
      evmVersion?: string;
    };
  };
}

export interface ArtifactData {
  abi: unknown[];
  contractName: string;
  sourceName?: string;
  buildInfoId?: string;
  sourceCode?: string;
  buildInfo?: ExplorerBuildInfo;
  deployments: string[];
}

interface DeployedAddresses {
  [key: string]: string;
}

export type AddressMap = Record<string, ArtifactData>;

const CHAIN_ID = 31337;

let hasLoggedArtifacts = false;

/**
 * Reduce a solc build info file to the fields the explorer reads.
 *
 * Build info carries the full standard JSON input - every source in the
 * compilation job - and each contract from that job points at the same file.
 * Injecting it whole repeats megabytes per contract, overflows the browser's
 * localStorage quota and leaves every contract showing as unverified. Source
 * resolution falls back to `input.sources`, so trim only after it has run.
 *
 * @param buildInfo - Parsed build info, shape unverified
 * @returns The fields the explorer reads, or undefined without build info
 */
export function toExplorerBuildInfo(
  buildInfo: unknown,
): ExplorerBuildInfo | undefined {
  if (typeof buildInfo !== "object" || buildInfo === null) return undefined;

  const { solcVersion, solcLongVersion, input } = buildInfo as {
    solcVersion?: string;
    solcLongVersion?: string;
    input?: { language?: string; settings?: { evmVersion?: string } };
  };

  return {
    solcVersion,
    solcLongVersion,
    input: {
      language: input?.language,
      settings: { evmVersion: input?.settings?.evmVersion },
    },
  };
}

export function findIgnitionDeployment(projectRoot: string): string | null {
  const deploymentPath = path.join(
    projectRoot,
    "ignition",
    "deployments",
    `chain-${CHAIN_ID}`,
  );
  const deployedAddressesPath = path.join(
    deploymentPath,
    "deployed_addresses.json",
  );

  if (existsSync(deployedAddressesPath)) {
    return deploymentPath;
  }

  return null;
}

export function loadArtifacts(
  deploymentPath: string,
  projectRoot: string,
): AddressMap {
  const addressMap: AddressMap = {};

  // Read deployed_addresses.json
  const deployedAddressesPath = path.join(
    deploymentPath,
    "deployed_addresses.json",
  );
  if (!existsSync(deployedAddressesPath)) {
    console.warn("[openscan] deployed_addresses.json not found");
    return addressMap;
  }

  const deployedAddresses: DeployedAddresses = JSON.parse(
    readFileSync(deployedAddressesPath, "utf-8"),
  );

  // Build contract name to address mapping
  const contractDeployments: Record<string, string> = {};
  for (const [moduleContract, address] of Object.entries(deployedAddresses)) {
    const contractName = moduleContract.split("#")[1];
    if (contractName) {
      contractDeployments[contractName] = address;
    }
  }

  // Read artifacts directory
  const artifactsDir = path.join(deploymentPath, "artifacts");
  if (!existsSync(artifactsDir)) {
    console.warn("[openscan] artifacts directory not found");
    return addressMap;
  }

  const artifactFiles = readdirSync(artifactsDir).filter((f) =>
    f.endsWith(".json"),
  );

  // Build-info directory
  const buildInfoDir = path.join(deploymentPath, "build-info");

  for (const artifactFile of artifactFiles) {
    const artifactPath = path.join(artifactsDir, artifactFile);

    let artifact: Record<string, unknown>;
    try {
      artifact = JSON.parse(readFileSync(artifactPath, "utf-8")) as Record<
        string,
        unknown
      >;
    } catch {
      continue;
    }

    const contractName = artifact.contractName as string | undefined;
    if (!contractName) continue;

    const deployedAddress = contractDeployments[contractName];
    if (!deployedAddress) continue;

    const artifactData: ArtifactData = {
      abi: (artifact.abi as unknown[]) || [],
      contractName,
      sourceName: artifact.sourceName as string | undefined,
      buildInfoId: artifact.buildInfoId as string | undefined,
      deployments: [deployedAddress],
    };

    // Try to load build info
    let buildInfo: unknown;
    if (artifactData.buildInfoId && existsSync(buildInfoDir)) {
      const buildInfoPath = path.join(
        buildInfoDir,
        `${artifactData.buildInfoId}.json`,
      );
      if (existsSync(buildInfoPath)) {
        try {
          buildInfo = JSON.parse(readFileSync(buildInfoPath, "utf-8"));
        } catch {
          // Ignore build info errors
        }
      }
    }

    // Try to load source code
    if (artifactData.sourceName) {
      artifactData.sourceCode = resolveSourceCode({
        projectRoot,
        sourceName: artifactData.sourceName,
        inputSourceName: artifact.inputSourceName as string | undefined,
        buildInfo,
      });
    }

    // Keep only the build info fields the explorer reads
    artifactData.buildInfo = toExplorerBuildInfo(buildInfo);

    // Store by lowercase address
    addressMap[deployedAddress.toLowerCase()] = artifactData;
  }

  return addressMap;
}

export function loadIgnitionArtifacts(projectRoot: string): AddressMap | null {
  const deploymentPath = findIgnitionDeployment(projectRoot);
  if (!deploymentPath) {
    return null;
  }

  const shouldLog = !hasLoggedArtifacts;
  if (shouldLog) {
    hasLoggedArtifacts = true;
    console.log(`[openscan] Found Ignition deployment at: ${deploymentPath}`);
  }

  const result = loadArtifacts(deploymentPath, projectRoot);

  if (shouldLog) {
    console.log(
      `[openscan] Loaded ${Object.keys(result).length} contract artifacts`,
    );
  }

  return result;
}
