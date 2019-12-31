import { ForgeLibContract } from "@utils/contracts";
import envSetup from "@utils/env_setup";
import { percentToWeight, simpleToExactAmount } from "@utils/math";
import { createBasket, createBasset, Basket } from "@utils/mstable-objects";
import * as chai from "chai";
import { shouldFail } from "openzeppelin-test-helpers";
import { StandardAccounts } from "@utils/machines/standardAccounts";

envSetup.configure();
const { expect, assert } = chai;

const ForgeLibArtifact = artifacts.require("ForgeLib");

contract("ForgeLib", async (accounts) => {
  const sa = new StandardAccounts(accounts);

  let forgeLib: ForgeLibContract;
  let emptyBasket: Basket;
  let standardBasket: Basket;
  let adjustingBasket: Basket;
  let adjustingBasketWithGrace: Basket;

  const TX_DEFAULTS = { from: sa._, gas: 5000000 };

  before("Init contract", async () => {
    const forgeLibInstance = await ForgeLibArtifact.new(TX_DEFAULTS);

    forgeLib = new ForgeLibContract(
      forgeLibInstance.address,
      web3.currentProvider,
      TX_DEFAULTS,
    );
  });

  beforeEach("Refresh the Basket objects", async () => {
    // T [50, 50]. C [0, 0]
    emptyBasket = createBasket([createBasset(50, 0), createBasset(50, 0)]);

    // T [40, 40, 20]. C [40, 40, 20]
    standardBasket = createBasket([
      createBasset(40, 4000, 18),
      createBasset(40, 4000, 14),
      createBasset(20, 2000, 6),
    ]);

    // T [40, 40, 20]. C [32, 36, 32]
    adjustingBasket = createBasket(
      [createBasset(40, 3200, 18), createBasset(40, 3600, 14), createBasset(20, 3200, 6)],
      0,
    );

    // T [40, 40, 20]. C [40.1, 40, 19.9]
    // Grace = 0.5% (i.e. PostWeight can be within 0.5% of T)
    adjustingBasketWithGrace = createBasket(
      [createBasset(40, 4010, 18), createBasset(40, 4000, 14), createBasset(20, 1990, 6)],
      0.5,
    );

    // T [40, 40, 20]. C [32, 36, 32]
    // TODO: recollateralisingBasket
  });

  describe("Test minting validation", () => {
    describe("Basic validation mechanisms", async () => {
      it("should throw if there is a missing basset", async () => {
        await shouldFail.reverting.withMessage(
          forgeLib.validateMint.callAsync(standardBasket, [
            simpleToExactAmount(200, 18),
            simpleToExactAmount(200, 14),
          ]),
          "Must provide values for all Bassets in system",
        );
      });

      it("should throw if there is an extra basset", async () => {
        await shouldFail.reverting.withMessage(
          forgeLib.validateMint.callAsync(standardBasket, [
            simpleToExactAmount(1000, 18),
            simpleToExactAmount(1000, 18),
            simpleToExactAmount(500, 6),
            simpleToExactAmount(0, 18),
          ]),
          "Must provide values for all Bassets in system",
        );
      });
    });

    describe("With empty basket", async () => {
      it("should not allow a mint that is not on the target weights", async () => {
        await shouldFail.reverting.withMessage(
          forgeLib.validateMint.callAsync(emptyBasket, [
            simpleToExactAmount(10000, 18),
            simpleToExactAmount(200, 18),
          ]),
          "Basket should not deviate from the optimal weightings",
        );
      });

      it("should allow a mint that is on the target weights", async () => {
        const isValidMint = await forgeLib.validateMint.callAsync(emptyBasket, [
          simpleToExactAmount(500, 18),
          simpleToExactAmount(500, 18),
        ]);
        assert(isValidMint, "Should be a valid mint!");
      });

      it("should allow completely empty minting to pass", async () => {
        const isValidMint = await forgeLib.validateMint.callAsync(emptyBasket, [
          simpleToExactAmount(0, 18),
          simpleToExactAmount(0, 18),
        ]);
        expect(isValidMint).to.be.true;
      });
    });

    describe("With static basket", () => {
      it("should allow a mint exactly on the target weights", async () => {
        const isValidMint = await forgeLib.validateMint.callAsync(standardBasket, [
          simpleToExactAmount(1000, 18),
          simpleToExactAmount(1000, 14),
          simpleToExactAmount(500, 6),
        ]);
        expect(isValidMint).to.be.true;
      });

      it("should not allow a mint that is not on the target weights", async () => {
        await shouldFail.reverting.withMessage(
          forgeLib.validateMint.callAsync(standardBasket, [
            simpleToExactAmount(1000, 18),
            simpleToExactAmount(1000, 14),
            simpleToExactAmount(501, 6),
          ]),
          "Basket should not deviate from the optimal weightings",
        );
      });

      it("should not allow a mint that is not on the target weights (even with grace)", async () => {
        standardBasket.grace = percentToWeight(50);

        await shouldFail.reverting.withMessage(
          forgeLib.validateMint.callAsync(standardBasket, [
            simpleToExactAmount(1000, 18),
            simpleToExactAmount(1000, 14),
            simpleToExactAmount(501, 6),
          ]),
          "Basket should not deviate from the optimal weightings",
        );
      });
    });

    describe("With adjusting basket", () => {
      it("should allow a mint exactly on the target weights", async () => {
        const isValidMint = await forgeLib.validateMint.callAsync(adjustingBasket, [
          simpleToExactAmount(2000, 18),
          simpleToExactAmount(2000, 14),
          simpleToExactAmount(1000, 6),
        ]);
        expect(isValidMint).to.be.true;
      });

      it("should allow a mint that pushes us closer to the target", async () => {
        const isValidMint = await forgeLib.validateMint.callAsync(adjustingBasket, [
          simpleToExactAmount(500, 18),
          simpleToExactAmount(0, 14),
          simpleToExactAmount(0, 6),
        ]);
        expect(isValidMint).to.be.true;
      });

      it("should allow a mint that pushes some bassets over target, so long as we move closer overall", async () => {
        const isValidMint = await forgeLib.validateMint.callAsync(adjustingBasket, [
          simpleToExactAmount(3000, 18),
          simpleToExactAmount(1500, 14),
          simpleToExactAmount(0, 6),
        ]);
        expect(isValidMint).to.be.true;
      });

      it("should throw if a mint pushes us further away", async () => {
        await shouldFail.reverting.withMessage(
          forgeLib.validateMint.callAsync(adjustingBasket, [
            simpleToExactAmount(32, 18),
            simpleToExactAmount(36, 14),
            simpleToExactAmount(33, 6),
          ]),
          "Forge must move Basket weightings towards the target",
        );
      });

      it("should throw if we go way over the target", async () => {
        await shouldFail.reverting.withMessage(
          forgeLib.validateMint.callAsync(adjustingBasket, [
            simpleToExactAmount(5000, 18),
            simpleToExactAmount(0, 14),
            simpleToExactAmount(0, 6),
          ]),
          "Forge must move Basket weightings towards the target",
        );
      });
    });

    describe("With adjusting basket (w/ Grace)", () => {
      it("should allow a mint with negative difference, within the grace range", async () => {
        const isValidMint = await forgeLib.validateMint.callAsync(
          adjustingBasketWithGrace,
          [
            simpleToExactAmount(410, 18),
            simpleToExactAmount(400, 14),
            simpleToExactAmount(190, 6),
          ],
        );
        expect(isValidMint).to.be.true;
      });

      it("should throw if the mint pushes us outside the grace range", async () => {
        await shouldFail.reverting.withMessage(
          forgeLib.validateMint.callAsync(adjustingBasketWithGrace, [
            simpleToExactAmount(480, 18),
            simpleToExactAmount(400, 14),
            simpleToExactAmount(200, 6),
          ]),
          "Forge must move Basket weightings towards the target",
        );
      });
    });

    describe("With Basket undergoing re-collateralisation", () => {
      // TODO

      it("Should calculate relative weightings assuming the basset has disappeared");
      it("Should throw if a user tries to forge with a basset under-peg");
      it("Should allow minting with a basset that is over-peg");
      it("Should act like a normal mint, excluding the basset");
    });

    describe("With all Bassets isolated in some way", () => {
      it("Should not allow minting if all bassets have deviated under-peg");
    });

    describe("With Basket full of failed assets", () => {
      // TODO
    });
  });

  describe("Test redeem validation ", () => {
    describe("With empty basket", () => {
      it("should not allow a redemption if there is insufficient balance", async () => {
        await shouldFail.reverting.withMessage(
          forgeLib.validateRedemption.callAsync(emptyBasket, [
            simpleToExactAmount(100, 18),
            simpleToExactAmount(100, 18),
          ]),
          "Vault must have sufficient balance to redeem",
        );
      });

      it("should allow completely empty redemption to pass", async () => {
        const isValidRedemption = await forgeLib.validateRedemption.callAsync(
          emptyBasket,
          [simpleToExactAmount(0, 18), simpleToExactAmount(0, 18)],
        );
        assert(isValidRedemption, "Should be a valid redemption!");
      });
    });

    describe("With static basket", () => {
      it("should throw if there is a missing basset", async () => {
        await shouldFail.reverting.withMessage(
          forgeLib.validateRedemption.callAsync(standardBasket, [
            simpleToExactAmount(200, 18),
            simpleToExactAmount(200, 18),
          ]),
          "Must provide values for all Bassets in system",
        );
      });

      // TODO - Check BassetQ response
    });

    describe("With adjusting basket", () => {
      // TODO
    });

    describe("With adjusting basket (w/ Grace)", () => {
      // TODO
    });

    describe("With Basket undergoing re-collateralisation", () => {
      // TODO
    });
  });
});