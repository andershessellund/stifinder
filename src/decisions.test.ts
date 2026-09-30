import { describe, expect, it } from 'vitest';
import {
  type DecisionState,
  type Decisions,
  DEVIATIONS_KEY,
  STEPS_KEY,
  ViolationError,
  check,
  decisionModel,
  exploreIteratively,
  formatViolation,
  runOnce,
} from './index.js';

/** The message of the ViolationError `check(body)` rejects with, as lines. */
async function failure(body: (decide: Decisions) => unknown, options?: Parameters<typeof check>[1]): Promise<string[]> {
  const error: unknown = await check(body, options).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ViolationError);
  return (error as Error).message.split('\n');
}

describe('a body of code, explored through its decisions', () => {
  it('runs the body once per leaf of its decision tree, and finds nothing wrong with one that never throws', async () => {
    let runs = 0;
    const model = decisionModel((decide) => {
      runs++;
      decide.integer(2);
      decide.integer(2);
      decide.integer(2);
    });
    const space = await check(model);
    expect([runs, model.runs]).toEqual([8, 8]);
    expect(space).toMatchObject({ completed: true, exhaustive: true, violation: null, maxDeviationsReached: 3 });
    expect(space.costs.size).toBe(15); // every prefix of three binary decisions
  });

  it('a decision of three is three alternatives', async () => {
    const model = decisionModel((decide) => {
      decide.integer(2);
      decide.integer(3);
    });
    await check(model);
    expect(model.runs).toBe(6);
  });

  it('bounded by maxDeviations, says the space was not exhausted', async () => {
    const model = decisionModel((decide) => {
      decide.integer(2);
      decide.integer(2);
      decide.integer(2);
    });
    const space = await check(model, { maxDeviations: 1 });
    // The expected run, then one run per single deviation.
    expect(model.runs).toBe(4);
    expect(space).toMatchObject({ completed: true, exhaustive: false, maxDeviationsReached: 1 });
  });

  it('reports the failure with the fewest deviations, not the first found, with the decisions to see it again', async () => {
    // Fails on [1, 1] (two deviations) and on [0, 0, 1] (one deviation).
    const lines = await failure((decide) => {
      const a = decide.integer(2, 'a strays');
      const b = decide.integer(2, 'b strays');
      if (a === 1 && b === 1) throw new Error('two deviations');
      const c = decide.integer(2, 'c strays');
      if (a === 0 && b === 0 && c === 1) throw new Error('one deviation');
    });
    expect(lines).toEqual(['one deviation', '1 deviation, 3 steps', '  3. c strays  (deviation)', 'in state: decisions [0, 0, 1]']);
  });

  it('a body that throws before its first decision fails at the initial state', async () => {
    // kilde's adapter passed this as exhaustive: the error had no edge to be reported on.
    const lines = await failure(() => {
      throw new Error('broken from the start');
    });
    expect(lines).toEqual(['broken from the start', 'no steps: the initial state fails', 'in state: decisions []']);
  });

  it('a body that fails on the expected run is a failure with no deviations', async () => {
    const lines = await failure((decide) => {
      decide.integer(2);
      throw new Error('always');
    });
    expect(lines).toEqual(['always', '0 deviations, 1 step', 'in state: decisions [0]']);
  });

  it('a body that returns a promise is awaited, and its rejection is its failure', async () => {
    // kilde's adapter ran on, and the rejection escaped as unhandled.
    const lines = await failure(async (decide) => {
      const a = decide.integer(2, 'a strays');
      await Promise.resolve();
      if (a === 1) throw new Error('async failure');
    });
    expect(lines).toEqual(['async failure', '1 deviation, 1 step', '  1. a strays  (deviation)', 'in state: decisions [1]']);
    const model = decisionModel(async (decide) => {
      decide.integer(2);
      await Promise.resolve();
      decide.integer(2);
    });
    await check(model);
    expect(model.runs).toBe(4);
  });

  it('the report lists the deviations alone by default, and every step on request', async () => {
    const body = (decide: Decisions) => {
      decide.integer(2, 'first strays');
      decide.integer(2, 'second strays');
      const third = decide.integer(2, 'third strays');
      if (third === 1) throw new Error('third');
    };
    expect(await failure(body)).toEqual(['third', '1 deviation, 3 steps', '  3. third strays  (deviation)', 'in state: decisions [0, 0, 1]']);
    expect(await failure(body, { report: { steps: 'all' } })).toEqual([
      'third',
      '1 deviation, 3 steps',
      '  1. first strays: no',
      '  2. second strays: no',
      '  3. third strays  (deviation)',
      'in state: decisions [0, 0, 1]',
    ]);
  });

  it('labels: a function is given the pick, words get the pick added above two alternatives, and none is the pick itself', async () => {
    const lines = await failure(
      (decide) => {
        decide.integer(3, (pick) => `picked ${['nothing', 'one', 'two'][pick]}`);
        decide.integer(3, 'strays');
        decide.integer(3);
        throw new Error('always');
      },
      { report: { steps: 'all' }, maxDeviations: 0 },
    );
    expect(lines).toEqual(['always', '0 deviations, 3 steps', '  1. picked nothing', '  2. strays: no', '  3. picked 0 of 3', 'in state: decisions [0, 0, 0]']);
    const two = await failure((decide) => {
      const a = decide.integer(3, 'strays');
      const b = decide.integer(3);
      if (a === 2 && b === 1) throw new Error('both');
    });
    expect(two).toEqual(['both', '2 deviations, 2 steps', '  1. strays (pick 2)  (deviation)', '  2. picked 1 of 3  (deviation)', 'in state: decisions [2, 1]']);
  });

  it('choose picks among alternatives, each with its own label and cost keys, and returns the value', async () => {
    const attempt = (decide: Decisions) =>
      decide.choose([
        { value: 'ok', label: 'the send succeeds' },
        { value: 'lost', label: 'the send is lost', cost: ['fault'] },
        { value: 'late', label: 'the send is late' },
      ]);
    const body = (decide: Decisions) => {
      const outcomes = [attempt(decide), attempt(decide)];
      if (outcomes.every((o) => o === 'lost')) throw new Error('never delivered');
    };
    // With one fault allowed, two losses are out of reach.
    const space = await check(body, { baseBudget: { fault: 1 } });
    expect(space).toMatchObject({ violation: null, completed: true, exhaustive: false });
    // With two, they are found, and each step says what it charged.
    const error: unknown = await check(body, { baseBudget: { fault: 2 } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ViolationError);
    const { violation, message } = error as ViolationError;
    expect(message.split('\n')).toEqual([
      'never delivered',
      '2 deviations, 2 steps, fault: 2',
      '  1. the send is lost  (deviation, fault)',
      '  2. the send is lost  (deviation, fault)',
      'in state: decisions [1, 1]',
    ]);
    expect(Object.fromEntries(violation.cost.entries())).toEqual({ fault: 2, [DEVIATIONS_KEY]: 2, [STEPS_KEY]: 2 });
  });

  it('a single alternative, or a range of 1, is no decision', async () => {
    const model = decisionModel((decide) => {
      expect(decide.choose([{ value: 'only' }])).toBe('only');
      expect(decide.integer(1)).toBe(0);
    });
    const space = await check(model);
    expect([model.runs, space.costs.size]).toEqual([1, 1]);
  });

  it('a body whose decisions change between runs is not deterministic, and the search says so', async () => {
    let calls = 0;
    await expect(
      check((decide) => {
        calls++;
        decide.integer(calls === 1 ? 2 : 3);
      }),
    ).rejects.toThrow(/had 2 alternatives before and 3 now: the body is not deterministic/);
    let runs = 0;
    await expect(
      check((decide) => {
        runs++;
        if (runs === 1) decide.integer(2);
      }),
    ).rejects.toThrow(/made 0 decisions, but 1 had been made before: it is not deterministic/);
  });

  it('a wrong use of Decisions is an error of the harness, not a failure of the body', async () => {
    await expect(check((decide) => decide.integer(0))).rejects.toThrow(/integer\(range\) needs a whole range of 1 or more, not 0/);
    await expect(check((decide) => decide.integer(1.5))).rejects.toThrow(/not 1.5/);
    await expect(check((decide) => decide.choose([]))).rejects.toThrow(/at least one alternative/);
    // Thrown through a body that catches everything, all the same.
    await expect(
      check((decide) => {
        try {
          decide.integer(0);
        } catch {
          // swallowed
        }
      }),
    ).resolves.toMatchObject({ violation: null });
  });

  it('is a model like any other: the picks are the events, and the search is the search', async () => {
    const model = decisionModel((decide) => {
      if (decide.integer(2) === 1 && decide.integer(2) === 1) throw new Error('both');
    });
    const space = await exploreIteratively(model);
    expect(space.violation!.steps.map((s) => s.event)).toEqual([1, 1]);
    expect(space.maxDeviationsReached).toBe(2);
    expect(formatViolation(space.violation!, model).split('\n')).toEqual([
      'both',
      '2 deviations, 2 steps',
      '  1. picked 1 of 2  (deviation)',
      '  2. picked 1 of 2  (deviation)',
      'in state: decisions [1, 1]',
    ]);
  });

  it('a decision made after the step allowance is out is not explored, and the search says it was not', async () => {
    const model = decisionModel((decide) => {
      decide.integer(2);
      decide.integer(2);
      if (decide.integer(2) === 1) throw new Error('third');
    });
    expect(await check(model, { baseBudget: { [STEPS_KEY]: 2 } })).toMatchObject({ violation: null, exhaustive: false });
    await expect(check(model)).rejects.toBeInstanceOf(ViolationError);
  });
});

describe('runOnce', () => {
  const body = (decide: Decisions) => {
    const a = decide.integer(2, 'a strays');
    const b = decide.integer(3, 'b strays');
    if (a === 1 && b === 2) throw new Error('the one that fails');
  };

  it('runs the body once with the decisions given, then 0, and rejects with what it throws', async () => {
    await expect(runOnce(body, [1, 2])).rejects.toThrow('the one that fails');
    await expect(runOnce(body, [1])).resolves.toBeUndefined(); // b is answered 0
    await expect(runOnce(body, [])).resolves.toBeUndefined();
  });

  it('replays the decisions a violation reports', async () => {
    const error = (await check(body).catch((e: unknown) => e)) as ViolationError<DecisionState, number>;
    const decisions = error.violation.steps.map((s) => s.event);
    expect(decisions).toEqual([1, 2]);
    await expect(runOnce(body, decisions)).rejects.toThrow('the one that fails');
  });

  it('rejects a decision the body does not offer, or more decisions than it makes', async () => {
    await expect(runOnce(body, [1, 3])).rejects.toThrow(/decision 1 has 3 alternatives, and pick 3 is not one of them/);
    await expect(runOnce(body, [0, 0, 0])).rejects.toThrow(/made 2 decisions of the 3 given/);
  });
});

describe('the README example', () => {
  // The code under test: send, and on failure try again, up to `attempts` times.
  function deliver(message: string, send: (message: string) => boolean, attempts: number): boolean {
    for (let i = 0; i < attempts; i++) if (send(message)) return true;
    return false;
  }
  const body = (decide: Decisions) => {
    const send = () => decide.choose([{ value: true, label: 'send succeeds' }, { value: false, label: 'send fails', cost: ['fault'] }]);
    if (!deliver('hello', send, 3)) throw new Error('gave up');
  };

  it('delivers unless every attempt fails', async () => {
    await check(body, { baseBudget: { fault: 2 } });
    expect(await failure(body)).toEqual([
      'gave up',
      '3 deviations, 3 steps, fault: 3',
      '  1. send fails  (deviation, fault)',
      '  2. send fails  (deviation, fault)',
      '  3. send fails  (deviation, fault)',
      'in state: decisions [1, 1, 1]',
    ]);
  });
});
