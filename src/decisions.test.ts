import { describe, expect, it } from 'vitest';
import {
  type DecisionBody,
  type DecisionState,
  DEVIATIONS_KEY,
  DecisionsError,
  STEPS_KEY,
  ViolationError,
  check,
  decisionModel,
  decisionsOf,
  exploreIteratively,
  formatViolation,
  runOnce,
} from './index.js';

type Options = NonNullable<Parameters<typeof check>[1]> & NonNullable<Parameters<typeof decisionModel>[1]>;

/** The ViolationError `check(decisionModel(body))` rejects with. */
async function failing(body: DecisionBody, options?: Options): Promise<ViolationError<DecisionState, number>> {
  const error: unknown = await check(decisionModel(body, options), options).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ViolationError);
  return error as ViolationError<DecisionState, number>;
}

/** Its message, as lines. */
const failure = async (body: DecisionBody, options?: Options) => (await failing(body, options)).message.split('\n');

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

  it('keeps what its runs found, so a second search of the same model reruns nothing', async () => {
    const model = decisionModel((decide) => {
      decide.integer(2);
    });
    await check(model);
    await check(model);
    expect(model.runs).toBe(2);
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

  it('the model asks for the charged steps alone in its report; a caller can ask for every step', async () => {
    const body: DecisionBody = (decide) => {
      decide.integer(2, 'first strays');
      decide.integer(2, 'second strays');
      const third = decide.integer(2, 'third strays');
      if (third === 1) throw new Error('third');
    };
    const charged = ['third', '1 deviation, 3 steps', '  3. third strays  (deviation)', 'in state: decisions [0, 0, 1]'];
    const all = [
      'third',
      '1 deviation, 3 steps',
      '  1. first strays: no',
      '  2. second strays: no',
      '  3. third strays  (deviation)',
      'in state: decisions [0, 0, 1]',
    ];
    const model = decisionModel(body);
    expect(model.report).toEqual({ steps: 'charged' });
    expect(await failure(body)).toEqual(charged);
    expect(await failure(body, { report: { steps: 'all' } })).toEqual(all);
    // The same by hand: the model's report is the default, and the caller's word the last.
    const { violation } = await exploreIteratively(model);
    expect(formatViolation(violation!, model).split('\n')).toEqual(charged);
    expect(formatViolation(violation!, model, { steps: 'all' }).split('\n')).toEqual(all);
    expect(formatViolation(violation!, { ...model, report: { steps: 'all' } }).split('\n')).toEqual(all);
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
    const attempt = (decide: Parameters<DecisionBody>[0]) =>
      decide.choose([
        { value: 'ok', label: 'the send succeeds' },
        { value: 'lost', label: 'the send is lost', cost: ['fault'] },
        { value: 'late', label: 'the send is late' },
      ]);
    const body: DecisionBody = (decide) => {
      const outcomes = [attempt(decide), attempt(decide)];
      // `outcomes` is ('ok' | 'lost' | 'late')[], so a typo here would not compile.
      if (outcomes.every((o) => o === 'lost')) throw new Error('never delivered');
    };
    // With one fault allowed, two losses are out of reach.
    const space = await check(decisionModel(body), { baseBudget: { fault: 1 } });
    expect(space).toMatchObject({ violation: null, completed: true, exhaustive: false });
    // With two, they are found, and each step says what it charged.
    const { violation, message } = await failing(body, { baseBudget: { fault: 2 } });
    expect(message.split('\n')).toEqual([
      'never delivered',
      '2 deviations, 2 steps, fault: 2',
      '  1. the send is lost  (deviation, fault)',
      '  2. the send is lost  (deviation, fault)',
      'in state: decisions [1, 1]',
    ]);
    expect(Object.fromEntries(violation.cost.entries())).toEqual({ fault: 2, [DEVIATIONS_KEY]: 2, [STEPS_KEY]: 2 });
  });

  it('an alternative without a label reads by its number', async () => {
    const lines = await failure((decide) => {
      if (decide.choose([{ value: 'a' }, { value: 'b' }]) === 'b') throw new Error('b');
    });
    expect(lines).toEqual(['b', '1 deviation, 1 step', '  1. alternative 1  (deviation)', 'in state: decisions [1]']);
  });

  it("check's own report option comes over the model's", async () => {
    const model = decisionModel((decide) => {
      decide.integer(2, 'strays');
      throw new Error('always');
    });
    const error: unknown = await check(model, { maxDeviations: 0, report: { steps: 'all' } }).catch((e: unknown) => e);
    expect((error as Error).message.split('\n')).toEqual(['always', '0 deviations, 1 step', '  1. strays: no', 'in state: decisions [0]']);
    const byDefault: unknown = await check(model, { maxDeviations: 0 }).catch((e: unknown) => e);
    expect((byDefault as Error).message.split('\n')).toEqual(['always', '0 deviations, 1 step', 'in state: decisions [0]']);
  });

  it("the first alternative's cost keys are charged too, on the expected run", async () => {
    const model = decisionModel((decide) => {
      decide.choose([{ value: 'paid', cost: ['coin'] }, { value: 'free' }]);
    });
    expect(await check(model, { baseBudget: { coin: 0 }, maxDeviations: 0 })).toMatchObject({ exhaustive: false });
    expect((await check(model, { baseBudget: { coin: 0 } })).costs.size).toBe(2); // the start, and `free`
    expect((await check(model)).costs.size).toBe(3);
  });

  it('maybe is a yes-or-no decision, no being expected, with a label and cost keys for yes', async () => {
    const lines = await failure((decide) => {
      const sent = !decide.maybe('the send fails', { cost: ['fault'] });
      if (!sent && decide.maybe('the retry fails')) throw new Error('gave up');
    });
    expect(lines).toEqual([
      'gave up',
      '2 deviations, 2 steps, fault: 1',
      '  1. the send fails  (deviation, fault)',
      '  2. the retry fails  (deviation)',
      'in state: decisions [1, 1]',
    ]);
  });

  it('a single alternative, or a range of 1, is no decision', async () => {
    const model = decisionModel((decide) => {
      expect(decide.choose([{ value: 'only' }])).toBe('only');
      expect(decide.integer(1)).toBe(0);
    });
    const space = await check(model);
    expect([model.runs, space.costs.size]).toEqual([1, 1]);
  });

  it('is a model like any other: the picks are the events, and the search is the search', async () => {
    const model = decisionModel((decide) => {
      if (decide.integer(2) === 1 && decide.integer(2) === 1) throw new Error('both');
    });
    const space = await exploreIteratively(model);
    expect(space.violation!.steps.map((s) => s.event)).toEqual([1, 1]);
    expect(space.maxDeviationsReached).toBe(2);
    expect(formatViolation(space.violation!, model, { steps: 'all' }).split('\n')).toEqual([
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

describe('a DecisionsError is the test being wrong, and never a violation', () => {
  it('a body whose decisions change between runs is not deterministic', async () => {
    let calls = 0;
    const error: unknown = await check(
      decisionModel((decide) => {
        calls++;
        decide.integer(calls === 1 ? 2 : 3);
      }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DecisionsError);
    expect(error).not.toBeInstanceOf(ViolationError);
    expect((error as Error).message).toBe('stifinder: decision 0 had 2 alternatives before and 3 now: the body is not deterministic (at decisions [1])');
    expect((error as DecisionsError).decisions).toEqual([1]);
    let runs = 0;
    await expect(
      check(
        decisionModel((decide) => {
          runs++;
          if (runs === 1) decide.integer(2);
        }),
      ),
    ).rejects.toThrow(DecisionsError);
  });

  it('a wrong use of Decisions', async () => {
    for (const body of [
      (decide: Parameters<DecisionBody>[0]) => decide.integer(0),
      (decide: Parameters<DecisionBody>[0]) => decide.integer(1.5),
      (decide: Parameters<DecisionBody>[0]) => decide.choose([]),
    ]) {
      await expect(check(decisionModel(body))).rejects.toBeInstanceOf(DecisionsError);
    }
    await expect(check(decisionModel((decide) => decide.integer(0)))).rejects.toThrow(/needs a whole range of 1 or more, not 0/);
  });

  it('is thrown again at every later decision, and once the body is done, so a body that catches it cannot hide it', async () => {
    let after = 0;
    const model = decisionModel((decide) => {
      try {
        decide.integer(0);
      } catch {
        // swallowed
      }
      after++;
      decide.integer(2); // throws again
      after++;
    });
    await expect(check(model)).rejects.toThrow(/needs a whole range/);
    expect(after).toBe(1);
    await expect(
      check(
        decisionModel((decide) => {
          try {
            decide.integer(0);
          } catch {
            // swallowed, and the body returns as if nothing happened
          }
        }),
      ),
    ).rejects.toBeInstanceOf(DecisionsError);
  });

  it('takes precedence over a failure the body throws afterwards', async () => {
    await expect(
      check(
        decisionModel((decide) => {
          try {
            decide.integer(0);
          } catch {
            throw new Error('a failure of my own');
          }
        }),
      ),
    ).rejects.toBeInstanceOf(DecisionsError);
  });


  it('a decision made once the body is done is thrown to the work that made it, and to the next search of the model', async () => {
    // The body leaves a timer running that decides after the run is over.
    const lateErrors: unknown[] = [];
    const model = decisionModel((decide) => {
      decide.integer(2);
      setTimeout(() => {
        try {
          decide.integer(2);
        } catch (error) {
          lateErrors.push(error);
        }
      }, 0);
    });
    // The search is over before any timer fires, so this one resolves.
    await check(model, { maxDeviations: 0 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(lateErrors).toHaveLength(1);
    expect(lateErrors[0]).toBeInstanceOf(DecisionsError);
    expect((lateErrors[0] as Error).message).toMatch(/decided after it was done/);
    // The model remembers, and the next search of it rejects at its first step.
    await expect(check(model)).rejects.toBe(lateErrors[0]);
    // A microtask the body queues runs before its run is over, and is a decision of the run,
    // whether the body then returns or throws.
    const queued = decisionModel((decide) => {
      decide.integer(2);
      queueMicrotask(() => decide.integer(2));
    });
    await check(queued);
    expect(queued.runs).toBe(4);
    const lines = await failure((decide) => {
      decide.integer(2);
      queueMicrotask(() => decide.integer(2));
      throw new Error('boom');
    }, { maxDeviations: 0 });
    expect(lines).toEqual(['boom', '0 deviations, 2 steps', 'in state: decisions [0, 0]']);
  });

  it('is met again by the next search of the model, like any callback that throws', async () => {
    const model = decisionModel((decide) => decide.integer(0));
    await expect(check(model)).rejects.toBeInstanceOf(DecisionsError);
    await expect(check(model)).rejects.toBeInstanceOf(DecisionsError);
    expect(model.runs).toBe(1);
  });
});

describe('a run past maxDecisions is a violation: the body does not end under that schedule', () => {
  const endless: DecisionBody = (decide) => {
    for (;;) decide.integer(2);
  };

  it('on the expected run, with no steps', async () => {
    const lines = await failure(endless, { maxDecisions: 100 });
    expect(lines).toEqual([
      'the body made more than 100 decisions in one run, and was cut off (maxDecisions)',
      'no steps: the initial state fails',
      'in state: decisions []',
    ]);
  });

  it('after a deviation, with the path to it: a livelock the search found', async () => {
    // Once a send has failed, the body polls for ever, though every poll succeeds.
    const livelock: DecisionBody = (decide) => {
      if (decide.maybe('the send fails', { cost: ['fault'] })) {
        for (;;) decide.maybe('the poll fails');
      }
    };
    const error = await failing(livelock, { maxDecisions: 50 });
    expect(error.message.split('\n')).toEqual([
      'the body made more than 50 decisions in one run, and was cut off (maxDecisions)',
      '1 deviation, 1 step, fault: 1',
      '  1. the send fails  (deviation, fault)',
      'in state: decisions [1]',
    ]);
    expect(decisionsOf(error)).toEqual([1]);
    await expect(runOnce(livelock, error, { maxDecisions: 50 })).rejects.toThrow(/more than 50 decisions/);
  });

  it('whatever the body does with the cut-off, and the default is 10,000', async () => {
    const swallowing: DecisionBody = (decide) => {
      try {
        for (;;) decide.integer(2);
      } catch {
        throw new Error('a failure of my own');
      }
    };
    expect((await failure(swallowing)).at(0)).toMatch(/more than 10000 decisions/);
    const fits = decisionModel((decide) => {
      for (let i = 0; i < 10_000; i++) decide.integer(1);
      for (let i = 0; i < 10_000; i++) decide.integer(2);
    });
    expect(await check(fits, { maxDeviations: 0 })).toMatchObject({ violation: null });
    // Infinity is no cap, as with every other limit. (A run that never ends then never ends.)
    expect(await check(decisionModel((decide) => decide.integer(2), { maxDecisions: Infinity }))).toMatchObject({ violation: null });
    expect(() => decisionModel(endless, { maxDecisions: 0 })).toThrow(RangeError);
  });

  it('runOnce reports it the same way, and takes the cap', async () => {
    await expect(runOnce(endless, [])).rejects.toThrow(/more than 10000 decisions/);
    await expect(runOnce(endless, [], { maxDecisions: 3 })).rejects.toThrow(/more than 3 decisions/);
    await expect(runOnce(endless, [], { maxDecisions: 0 })).rejects.toThrow(RangeError);
  });
});

describe('runOnce and decisionsOf', () => {
  const body: DecisionBody = (decide) => {
    const a = decide.integer(2, 'a strays');
    const b = decide.integer(3, 'b strays');
    if (a === 1 && b === 2) throw new Error('the one that fails');
  };

  it('runs the body once with the decisions given, then 0, and rejects with what it throws', async () => {
    await expect(runOnce(body, [1, 2])).rejects.toThrow('the one that fails');
    await expect(runOnce(body, [1])).resolves.toBeUndefined(); // b is answered 0
    await expect(runOnce(body, [])).resolves.toBeUndefined();
  });

  it('replays the decisions of a violation, from the error, the path, or the numbers', async () => {
    const error = await failing(body);
    expect(decisionsOf(error)).toEqual([1, 2]);
    expect(decisionsOf(error.violation)).toEqual([1, 2]);
    await expect(runOnce(body, error)).rejects.toThrow('the one that fails');
    await expect(runOnce(body, error.violation)).rejects.toThrow('the one that fails');
    await expect(runOnce(body, decisionsOf(error))).rejects.toThrow('the one that fails');
  });

  it('a violation of some other model has no decisions', async () => {
    const other = await exploreIteratively<number, string>({
      initialState: 0,
      getEvents: () => [{ event: 'boom' }],
      applyEvent: () => ({ error: 'always' }),
    });
    expect(() => decisionsOf(other.violation!)).toThrow(DecisionsError);
  });

  it('rejects a decision the body does not offer, or more decisions than it makes', async () => {
    await expect(runOnce(body, [1, 3])).rejects.toThrow(/decision 1 has 3 alternatives, and pick 3 is not one of them \(at decisions \[1, 3\]\)/);
    await expect(runOnce(body, [0, 0, 0])).rejects.toThrow(/made 2 decisions of the 3 given/);
  });

  it('a body that throws before it has made all the decisions given rejects with its own throw', async () => {
    // A search calls this non-deterministic; a debugger wants the failure itself.
    await expect(runOnce((decide) => {
      decide.integer(2);
      throw new Error('mine');
    }, [0, 0, 0])).rejects.toThrow('mine');
  });

  it('a failure past the last deviation replays too', async () => {
    const past: DecisionBody = (decide) => {
      const strayed = decide.integer(2) === 1;
      decide.integer(2);
      decide.integer(2);
      if (strayed) throw new Error('late consequence');
    };
    const error = await failing(past);
    expect(decisionsOf(error)).toEqual([1, 0, 0]);
    await expect(runOnce(past, error)).rejects.toThrow('late consequence');
  });
});

describe('the README example', () => {
  // The code under test: send, and on failure try again, up to `attempts` times.
  function deliver(message: string, send: (message: string) => boolean, attempts: number): boolean {
    for (let i = 0; i < attempts; i++) if (send(message)) return true;
    return false;
  }
  const body: DecisionBody = (decide) => {
    const send = () => !decide.maybe('the send fails', { cost: ['fault'] });
    if (!deliver('hello', send, 3)) throw new Error('gave up');
  };

  it('delivers unless every attempt fails', async () => {
    await check(decisionModel(body), { baseBudget: { fault: 2 } });
    expect(await failure(body)).toEqual([
      'gave up',
      '3 deviations, 3 steps, fault: 3',
      '  1. the send fails  (deviation, fault)',
      '  2. the send fails  (deviation, fault)',
      '  3. the send fails  (deviation, fault)',
      'in state: decisions [1, 1, 1]',
    ]);
  });
});
