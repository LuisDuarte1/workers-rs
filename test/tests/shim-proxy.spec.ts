import { describe, test, expect } from "vitest";

/**
 * Unit tests for the shim's Proxy-based recovery machinery.
 *
 * These tests directly exercise the classProxyHooks / instanceProxyHooks
 * logic without going through miniflare/workerd, allowing us to test
 * edge cases like the get trap's reconstruction path that are hard to
 * trigger from integration tests.
 */

/**
 * Recreate the exact shim proxy machinery from worker-build/src/js/shim.js.
 * We parameterize the WASM reset function and panic hook so we can control
 * them from the test.
 */
function createShimProxy() {
  let criticalError = false;
  let instanceId = 0;
  let resetCount = 0;

  function checkReinitialize() {
    if (criticalError) {
      resetCount++;
      criticalError = false;
      instanceId++;
    }
  }

  function handleMaybeCritical(e: unknown) {
    if (e instanceof Error && (e as any).__wasm_runtime_error) {
      criticalError = true;
    }
  }

  const instanceProxyHooks = {
    set: (target: any, prop: any, value: any, receiver: any) =>
      Reflect.set(target.instance, prop, value, receiver),
    has: (target: any, prop: any) => Reflect.has(target.instance, prop),
    deleteProperty: (target: any, prop: any) =>
      Reflect.deleteProperty(target.instance, prop),
    apply: (target: any, thisArg: any, args: any) =>
      Reflect.apply(target.instance, thisArg, args),
    construct: (target: any, args: any, newTarget: any): object =>
      Reflect.construct(target.instance, args, newTarget),
    getPrototypeOf: (target: any) => Reflect.getPrototypeOf(target.instance),
    setPrototypeOf: (target: any, proto: any) =>
      Reflect.setPrototypeOf(target.instance, proto),
    isExtensible: (target: any) => Reflect.isExtensible(target.instance),
    preventExtensions: (target: any) =>
      Reflect.preventExtensions(target.instance),
    getOwnPropertyDescriptor: (target: any, prop: any) =>
      Reflect.getOwnPropertyDescriptor(target.instance, prop),
    defineProperty: (target: any, prop: any, descriptor: any) =>
      Reflect.defineProperty(target.instance, prop, descriptor),
    ownKeys: (target: any) => Reflect.ownKeys(target.instance),
  };

  // This is the FIXED version of classProxyHooks from shim.js.
  // The key difference is the get trap calls checkReinitialize() and
  // wraps reconstruction in try/catch.
  const classProxyHooksFixed = {
    construct(ctor: any, args: any, newTarget: any) {
      try {
        checkReinitialize();
        const instance = {
          instance: Reflect.construct(ctor, args, newTarget),
          instanceId,
          ctor,
          args,
          newTarget,
        };
        return new Proxy(instance, {
          ...instanceProxyHooks,
          get(target: any, prop: any, receiver: any) {
            if (target.instanceId !== instanceId) {
              checkReinitialize(); // <-- THE FIX
              try {
                target.instance = Reflect.construct(
                  target.ctor,
                  target.args,
                  target.newTarget,
                );
                target.instanceId = instanceId;
              } catch (e) {
                criticalError = true;
                throw e;
              }
            }
            const original = Reflect.get(target.instance, prop, receiver);
            if (typeof original !== "function") return original;
            if (original.constructor === Function) {
              return new Proxy(original, {
                apply(target2: any, thisArg: any, argArray: any) {
                  checkReinitialize();
                  try {
                    return target2.apply(thisArg, argArray);
                  } catch (e) {
                    handleMaybeCritical(e);
                    throw e;
                  }
                },
              });
            } else {
              return new Proxy(original, {
                async apply(target2: any, thisArg: any, argArray: any) {
                  checkReinitialize();
                  try {
                    return await target2.apply(thisArg, argArray);
                  } catch (e) {
                    handleMaybeCritical(e);
                    throw e;
                  }
                },
              });
            }
          },
        });
      } catch (e) {
        criticalError = true;
        throw e;
      }
    },
  };

  // The UNFIXED version - missing checkReinitialize() and try/catch in get trap
  const classProxyHooksUnfixed = {
    construct(ctor: any, args: any, newTarget: any) {
      try {
        checkReinitialize();
        const instance = {
          instance: Reflect.construct(ctor, args, newTarget),
          instanceId,
          ctor,
          args,
          newTarget,
        };
        return new Proxy(instance, {
          ...instanceProxyHooks,
          get(target: any, prop: any, receiver: any) {
            if (target.instanceId !== instanceId) {
              // NO checkReinitialize() here -- this is the bug
              target.instance = Reflect.construct(
                target.ctor,
                target.args,
                target.newTarget,
              );
              target.instanceId = instanceId;
            }
            const original = Reflect.get(target.instance, prop, receiver);
            if (typeof original !== "function") return original;
            if (original.constructor === Function) {
              return new Proxy(original, {
                apply(target2: any, thisArg: any, argArray: any) {
                  checkReinitialize();
                  try {
                    return target2.apply(thisArg, argArray);
                  } catch (e) {
                    handleMaybeCritical(e);
                    throw e;
                  }
                },
              });
            } else {
              return new Proxy(original, {
                async apply(target2: any, thisArg: any, argArray: any) {
                  checkReinitialize();
                  try {
                    return await target2.apply(thisArg, argArray);
                  } catch (e) {
                    handleMaybeCritical(e);
                    throw e;
                  }
                },
              });
            }
          },
        });
      } catch (e) {
        criticalError = true;
        throw e;
      }
    },
  };

  return {
    classProxyHooksFixed,
    classProxyHooksUnfixed,
    setCriticalError: (v: boolean) => {
      criticalError = v;
    },
    getCriticalError: () => criticalError,
    getInstanceId: () => instanceId,
    getResetCount: () => resetCount,
  };
}

describe("Shim Proxy get trap reinitialization", () => {
  test("UNFIXED: get trap does NOT call checkReinitialize before reconstruction", () => {
    const shim = createShimProxy();

    // Simulate a class whose OnceLock init might fail.
    // Track how many times the constructor is called.
    let constructCount = 0;
    let shouldPanic = false;

    class FakeDO {
      value: string;
      constructor() {
        constructCount++;
        if (shouldPanic) {
          throw new Error(
            "OnceLock poisoned: one-time initialization may not be performed recursively",
          );
        }
        this.value = "ok";
      }
      fetch() {
        return "response";
      }
    }

    const ProxiedClass = new Proxy(FakeDO, shim.classProxyHooksUnfixed);

    // Step 1: Construct successfully (instanceId=0)
    const instance = new (ProxiedClass as any)();
    expect(instance.value).toBe("ok");
    expect(constructCount).toBe(1);

    // Step 2: Simulate a WASM panic + reset (bumps instanceId to 1)
    // In the real shim, checkReinitialize() does this.
    // Here we manually set criticalError and trigger a construct trap
    // (which calls checkReinitialize).
    shim.setCriticalError(true);
    constructCount = 0;

    const instance2 = new (ProxiedClass as any)();
    expect(instance2.value).toBe("ok");
    expect(constructCount).toBe(1);
    expect(shim.getInstanceId()).toBe(1); // instanceId was bumped
    expect(shim.getResetCount()).toBe(1);

    // Step 3: Now simulate another panic that poisons the OnceLock.
    // Set criticalError but DON'T go through the construct trap.
    // Instead, access a property on the OLD instance (from step 1),
    // which has stale instanceId=0 !== current instanceId=1.
    shim.setCriticalError(true);
    shouldPanic = true; // Next construction will fail (simulating poisoned OnceLock)

    // The OLD instance's get trap will see stale instanceId and try
    // to reconstruct. In the UNFIXED version, it does NOT call
    // checkReinitialize() first, so criticalError stays true and
    // instanceId is not bumped. The reconstruction uses the "poisoned"
    // constructor that throws.
    expect(() => {
      instance.fetch; // triggers get trap -> reconstruction -> throws
    }).toThrow("one-time initialization may not be performed recursively");

    // criticalError should still be true since unfixed doesn't handle it
    // (no try/catch in get trap to set criticalError)
    // Actually in unfixed, the construct trap's outer catch sets criticalError=true
    // but the get trap has no such catch.
  });

  test("FIXED: get trap calls checkReinitialize before reconstruction", () => {
    const shim = createShimProxy();

    let constructCount = 0;
    let shouldPanic = false;

    class FakeDO {
      value: string;
      constructor() {
        constructCount++;
        if (shouldPanic) {
          throw new Error("OnceLock poisoned");
        }
        this.value = "ok";
      }
      fetch() {
        return "response";
      }
    }

    const ProxiedClass = new Proxy(FakeDO, shim.classProxyHooksFixed);

    // Step 1: Construct successfully (instanceId=0)
    const instance = new (ProxiedClass as any)();
    expect(instance.value).toBe("ok");
    expect(constructCount).toBe(1);

    // Step 2: Simulate a WASM panic + reset
    shim.setCriticalError(true);
    constructCount = 0;

    const instance2 = new (ProxiedClass as any)();
    expect(instance2.value).toBe("ok");
    expect(shim.getInstanceId()).toBe(1);
    expect(shim.getResetCount()).toBe(1);

    // Step 3: Simulate another panic. Set criticalError and make
    // constructor fail (simulating poisoned OnceLock).
    shim.setCriticalError(true);
    shouldPanic = true;

    // Access property on OLD instance (stale instanceId=0).
    // FIXED get trap calls checkReinitialize() first, which bumps
    // instanceId to 2 and clears criticalError. Then the reconstruction
    // still fails (shouldPanic=true), but it's a clean failure, not
    // recursive-init.
    expect(shim.getResetCount()).toBe(1);
    expect(() => {
      instance.fetch; // triggers get trap -> checkReinitialize -> reconstruction -> throws
    }).toThrow("OnceLock poisoned");

    // The fix's try/catch should have set criticalError=true
    expect(shim.getCriticalError()).toBe(true);
    // checkReinitialize was called, bumping resetCount
    expect(shim.getResetCount()).toBe(2);
    expect(shim.getInstanceId()).toBe(2);

    // Step 4: Now make constructor succeed again (simulating a fresh
    // WASM instance after proper reset)
    shouldPanic = false;
    constructCount = 0;

    // Access property on the OLD instance again. It still has stale
    // instanceId. With fix, checkReinitialize() clears criticalError
    // (set in step 3), resets, then reconstructs successfully.
    const fetchFn = instance.fetch;
    expect(typeof fetchFn).toBe("function");
    expect(shim.getResetCount()).toBe(3);
    expect(shim.getInstanceId()).toBe(3);
  });

  test("UNFIXED vs FIXED: unfixed does not reset before get-trap reconstruction", () => {
    // This test proves the bug exists in the unfixed version.
    // It tracks whether checkReinitialize ran before reconstruction
    // by checking resetCount.

    const shim = createShimProxy();

    class FakeDO {
      value = "ok";
      fetch() {
        return "response";
      }
    }

    const ProxiedUnfixed = new Proxy(FakeDO, shim.classProxyHooksUnfixed);

    // Construct (instanceId=0)
    const instance = new (ProxiedUnfixed as any)();
    expect(instance.value).toBe("ok");

    // Simulate panic
    shim.setCriticalError(true);

    // Trigger construct trap on a new instance (this calls checkReinitialize)
    const instance2 = new (ProxiedUnfixed as any)();
    expect(shim.getResetCount()).toBe(1);
    expect(shim.getInstanceId()).toBe(1);

    // Now set criticalError again
    shim.setCriticalError(true);
    const resetCountBefore = shim.getResetCount();

    // Access property on OLD instance -> get trap -> reconstruction
    // UNFIXED: does NOT call checkReinitialize before Reflect.construct
    const _ = instance.fetch;
    const resetCountAfter = shim.getResetCount();

    // In the UNFIXED version, checkReinitialize was NOT called in the
    // get trap, so resetCount should be the same.
    expect(resetCountAfter).toBe(resetCountBefore);

    // criticalError should still be true (never cleared by get trap)
    expect(shim.getCriticalError()).toBe(true);
  });

  test("FIXED: fixed DOES reset before get-trap reconstruction", () => {
    const shim = createShimProxy();

    class FakeDO {
      value = "ok";
      fetch() {
        return "response";
      }
    }

    const ProxiedFixed = new Proxy(FakeDO, shim.classProxyHooksFixed);

    // Construct (instanceId=0)
    const instance = new (ProxiedFixed as any)();
    expect(instance.value).toBe("ok");

    // Simulate panic
    shim.setCriticalError(true);

    // Trigger construct trap on a new instance
    const instance2 = new (ProxiedFixed as any)();
    expect(shim.getResetCount()).toBe(1);
    expect(shim.getInstanceId()).toBe(1);

    // Now set criticalError again
    shim.setCriticalError(true);
    const resetCountBefore = shim.getResetCount();

    // Access property on OLD instance -> get trap -> reconstruction
    // FIXED: calls checkReinitialize before Reflect.construct
    const _ = instance.fetch;
    const resetCountAfter = shim.getResetCount();

    // In the FIXED version, checkReinitialize WAS called, so resetCount
    // should have incremented.
    expect(resetCountAfter).toBe(resetCountBefore + 1);

    // criticalError should be false (cleared by checkReinitialize)
    expect(shim.getCriticalError()).toBe(false);
  });
});
