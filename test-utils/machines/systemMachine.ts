import { RecollateraliserContract } from "./../../types/generated/recollateraliser";
import { MASSET_FACTORY_BYTES } from "@utils/constants";
import {
  ERC20MockContract,
  GovernancePortalMockContract,
  ManagerMockContract,
  MassetFactoryV1Contract,
  NexusMockContract,
  OracleHubMockContract,
  SystokMockContract,
} from "@utils/contracts";
import { Address } from "../../types/common";
import { createMultiple, percentToWeight } from "@utils/math";
import { aToH, BigNumber } from "@utils/tools";
import { BassetMachine } from "./bassetMachine";
import { StandardAccounts } from "./standardAccounts";

const CommonHelpersArtifact = artifacts.require("CommonHelpers");
const StableMathArtifact = artifacts.require("StableMath");
const Erc20Artifact = artifacts.require("ERC20Mock");

const GovernancePortalArtifact = artifacts.require("GovernancePortalMock");

const ManagerArtifact = artifacts.require("ManagerMock");
const MassetFactoryArtifact = artifacts.require("MassetFactoryV1");

const MassetArtifact = artifacts.require("Masset");
const ForgeLibArtifact = artifacts.require("ForgeLib");

const NexusArtifact = artifacts.require("NexusMock");

const OracleHubPriceDataArtifact = artifacts.require("OracleHubPriceDataMock");
const OracleHubArtifact = artifacts.require("OracleHubMock");

const RecollateraliserArtifact = artifacts.require("Recollateraliser");

const SystokArtifact = artifacts.require("SystokMock");

/**
 * @dev The SystemMachine is responsible for creating mock versions of our contracts
 * Since we will need to generate usable, customisable contracts throughout our test
 * framework, this will act as a Machine to generate these various mocks
 */
export class SystemMachine {

  /**
   * @dev Default accounts as per system Migrations
   */
  public sa: StandardAccounts;

  public governancePortal: GovernancePortalMockContract;
  public massetFactory: MassetFactoryV1Contract;
  public manager: ManagerMockContract;
  public nexus: NexusMockContract;
  public oracleHub: OracleHubMockContract;
  public recollateraliser: RecollateraliserContract;
  public systok: SystokMockContract;

  private TX_DEFAULTS: any;

  constructor(accounts: Address[], defaultSender: Address, defaultGas: number = 50000000) {
    this.sa = new StandardAccounts(accounts);

    this.TX_DEFAULTS = {
      from: defaultSender,
      gas: defaultGas,
    };
  }

  /**
   * @dev Initialises the system to replicate current migration scripts
   */
  public async initialiseMocks() {
    try {

      // TODO: figure out why this isn't propagating from env_setup
      web3.currentProvider["sendAsync"] = web3.currentProvider["send"];

      /** Shared */
      await CommonHelpersArtifact.new();
      await StableMathArtifact.new();

      /** NexusMock */
      await this.deployNexus();

      /** OracleHubMock */
      const oracleHub = await this.deployOracleHub();
      // add module
      await this.addModuleToNexus(await oracleHub.Key_OracleHub.callAsync(), oracleHub.address);

      /** SystokMock */
      const systok = await this.deploySystok();
      // add module
      await this.addModuleToNexus(await systok.Key_Systok.callAsync(), systok.address);

      /** Governance */
      const governancePortal = await this.deployGovernancePortal();
      // add module
      await this.addModuleToNexus(await governancePortal.Key_GovernancePortal.callAsync(), governancePortal.address);

      /** ManagerMock */
      const manager = await this.deployManager();
      // add module
      await this.addModuleToNexus(await manager.Key_Manager.callAsync(), manager.address);

      /** MassetFactory + add to Manager */
      await this.deployMassetFactory();

      /** Recollateraliser */
      const recollateraliser = await this.deployRecollateraliser();
      // add module
      await this.addModuleToNexus(await recollateraliser.Key_Recollateraliser.callAsync(), recollateraliser.address);

      return Promise.resolve(true);

    } catch (e) {
      console.log(e);
      return Promise.reject(e);
    }
  }

  /**
   * @dev Deploy the NexusMock
   */
  public async deployNexus(
    deployer: Address = this.sa.default,
  ): Promise<NexusMockContract> {
    try {
      const mockInstance = await NexusArtifact.new(this.sa.governor, { from: deployer });

      this.nexus = new NexusMockContract(
        mockInstance.address,
        web3.currentProvider,
        this.TX_DEFAULTS,
      );

      return this.nexus;
    } catch (e) {
      throw e;
    }
  }

  /**
   * @dev Deploy the OracleHubMock
   */
  public async deployOracleHub(
    deployer: Address = this.sa.default,
  ): Promise<OracleHubMockContract> {
    try {
      const oracleHubPriceDataInstance = await OracleHubPriceDataArtifact.new({ from: deployer });

      const oracleHubInstance = await OracleHubArtifact.new(this.sa.governor, this.nexus.address,
        oracleHubPriceDataInstance.address, [this.sa.oraclePriceProvider], { from: deployer });

      this.oracleHub = new OracleHubMockContract(
        oracleHubInstance.address,
        web3.currentProvider,
        this.TX_DEFAULTS,
      );

      return this.oracleHub;
    } catch (e) {
      throw e;
    }
  }

  /**
   * @dev Deploy the SystokMock token
   */
  public async deploySystok(): Promise<SystokMockContract> {
    try {
      const mockInstance = await SystokArtifact.new(
        this.nexus.address,
        this.sa.fundManager,
        { from: this.sa.default },
      );

      this.systok = new SystokMockContract(
        mockInstance.address,
        web3.currentProvider,
        this.TX_DEFAULTS,
      );

      return this.systok;
    } catch (e) {
      throw e;
    }
  }

  /**
   * @dev Deploy the Governance Portal
   */
  public async deployGovernancePortal(
    govOwners: Address[] = this.sa.all.slice(4, 10),
    minQuorum: number = 3,
  ): Promise<GovernancePortalMockContract> {
    try {
      const mockInstance = await GovernancePortalArtifact.new(this.nexus.address, govOwners, minQuorum, { from: this.sa.default });

      this.governancePortal = new GovernancePortalMockContract(
        mockInstance.address,
        web3.currentProvider,
        this.TX_DEFAULTS,
      );

      return this.governancePortal;
    } catch (e) {
      throw e;
    }
  }

  /**
   * @dev Deploy ManagerMock and relevant init
   */
  public async deployManager(
  ): Promise<ManagerMockContract> {
    try {
      const stableMathInstance = await StableMathArtifact.deployed();
      await ForgeLibArtifact.link(StableMathArtifact, stableMathInstance.address);
      const forgeLibInstance = await ForgeLibArtifact.new();

      await ManagerArtifact.link(StableMathArtifact, stableMathInstance.address);

      const mockInstance = await ManagerArtifact.new(
        this.sa.governor,
        this.nexus.address,
        this.systok.address,
        this.oracleHub.address,
        forgeLibInstance.address,
      );
      this.manager = new ManagerMockContract(
        mockInstance.address,
        web3.currentProvider,
        this.TX_DEFAULTS,
      );

      return this.manager;
    } catch (e) {
      throw e;
    }
  }

  /**
   * @dev Deploy a Masset via the Manager
   */
  public async createMassetViaManager(
    sender: Address = this.sa.governor,
  ): Promise<Address> {
    const bassetMachine = new BassetMachine(this.sa.default, this.sa.other, 500000);

    const b1: ERC20MockContract = await bassetMachine.deployERC20Async();
    const b2: ERC20MockContract = await bassetMachine.deployERC20Async();

    // LOG FACTORY NAMES // BYTES AS CONSTANTS
    return this.manager.createMasset.sendTransactionAsync(
      MASSET_FACTORY_BYTES,
      aToH("TMT"),
      "TestMasset",
      "TMT",
      [b1.address, b2.address],
      [aToH("b1"), aToH("b2")],
      [percentToWeight(50), percentToWeight(50)],
      [createMultiple(1), createMultiple(1)],
      [new BigNumber(0), new BigNumber(0)],
      { from: sender },
    );
  }

  /**
   * @dev Deploy MassetFactory and add it to Manager
   */
  public async deployMassetFactory(
  ): Promise<MassetFactoryV1Contract> {
    try {
      const stableMathInstance = await StableMathArtifact.deployed();
      await MassetArtifact.link(StableMathArtifact, stableMathInstance.address);
      const commonHelpersInstance = await CommonHelpersArtifact.deployed();
      await MassetArtifact.link(CommonHelpersArtifact, commonHelpersInstance.address);

      await MassetFactoryArtifact.link(StableMathArtifact, stableMathInstance.address);
      await MassetFactoryArtifact.link(CommonHelpersArtifact, commonHelpersInstance.address);

      const massetFactoryInstance = await MassetFactoryArtifact.new(this.manager.address);
      this.massetFactory = new MassetFactoryV1Contract(
        massetFactoryInstance.address,
        web3.currentProvider,
        this.TX_DEFAULTS,
      );
      await this.manager.setFactory.sendTransactionAsync(MASSET_FACTORY_BYTES, this.massetFactory.address, { from: this.sa.governor });

      return this.massetFactory;
    } catch (e) {
      throw e;
    }
  }

  /**
   * @dev Deploy Recollateraliser and add it to Manager
   */
  public async deployRecollateraliser(
  ): Promise<RecollateraliserContract> {
    try {
      const stableMathInstance = await StableMathArtifact.deployed();
      await RecollateraliserArtifact.link(StableMathArtifact, stableMathInstance.address);

      const recollateraliserInstance = await RecollateraliserArtifact.new(
        this.nexus.address,
        this.manager.address,
        this.systok.address,
      );
      this.recollateraliser = new RecollateraliserContract(
        recollateraliserInstance.address,
        web3.currentProvider,
        this.TX_DEFAULTS,
      );
      return this.recollateraliser;
    } catch (e) {
      throw e;
    }
  }

  public async addModuleToNexus(
    moduleKey: string,
    moduleAddress: Address,
    subscribe: boolean = true,
    sender: Address = this.sa.governor,
  ): Promise<string> {
    return this.nexus.addModule.sendTransactionAsync(moduleKey, moduleAddress, subscribe, { from: sender });
  }
}