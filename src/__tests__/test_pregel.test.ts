import { it, expect, jest } from "@jest/globals";
import { Channel, Pregel } from "../index.js";
import { LastValue } from "../channels/last_value.js";
import { Graph } from "../graph/index.js";
import { ReservedChannels } from "../pregel/reserved.js";
import { Topic } from "../channels/topic.js";
import { ChannelInvoke } from "../pregel/read.js";
import { InvalidUpdateError } from "../channels/base.js";
import { MemorySaver } from "../checkpoint/memory.js";
import { BinaryOperatorAggregate } from "../channels/binop.js";

it("can invoke pregel with a single process", async () => {
  const addOne = jest.fn((x: number): number => x + 1);
  const chain = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));

  const app = new Pregel({
    nodes: {
      one: chain
    },
    channels: {
      input: new LastValue<number>(),
      output: new LastValue<number>()
    },
    input: "input",
    output: "output"
  });

  expect(await app.invoke(2)).toBe(3);
  expect(await app.invoke(2, undefined, ["output"])).toEqual({ output: 3 });
  expect(() => app.toString()).not.toThrow();
  // Verify the mock was called correctly
  expect(addOne).toHaveBeenCalled();
});

it("can invoke graph with a single process", async () => {
  const addOne = jest.fn((x: number): number => x + 1);

  const graph = new Graph();
  graph.addNode("add_one", addOne);
  graph.setEntryPoint("add_one");
  graph.setFinishPoint("add_one");
  const gapp = graph.compile();

  expect(await gapp.invoke(2)).toBe(3);
});

it("should process input and produce output with implicit channels", async () => {
  const addOne = jest.fn((x: number): number => x + 1);
  const chain = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));

  const app = new Pregel({ nodes: { one: chain } });

  expect(await app.invoke(2)).toBe(3);

  // Verify the mock was called correctly
  expect(addOne).toHaveBeenCalled();
});

it("should process input and write kwargs correctly", async () => {
  const addOne = jest.fn((x: number): number => x + 1);
  const chain = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(
      Channel.writeTo("output", {
        fixed: 5,
        outputPlusOne: (x: number) => x + 1
      })
    );

  const app = new Pregel({
    nodes: { one: chain },
    output: ["output", "fixed", "outputPlusOne"]
  });

  expect(await app.invoke(2)).toEqual({
    output: 3,
    fixed: 5,
    outputPlusOne: 4
  });
});

it("should process input and check for last step", async () => {
  const addOne = jest.fn((x: { input: number; is_last_step?: boolean }) => ({
    ...x,
    input: x.input + 1
  }));
  const chain = Channel.subscribeTo(["input"])
    .join([ReservedChannels.isLastStep])
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));

  const app = new Pregel({
    nodes: { one: chain }
  });

  expect(await app.invoke(2)).toEqual({ input: 3, isLastStep: false });
  expect(await app.invoke(2, { recursionLimit: 1 })).toEqual({
    input: 3,
    isLastStep: true
  });
});

it("should invoke single process in out objects", async () => {
  const addOne = jest.fn((x: number): number => x + 1);
  const chain = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));

  const app = new Pregel({
    nodes: {
      one: chain
    },
    output: ["output"]
  });

  expect(await app.invoke(2)).toEqual({ output: 3 });
});

it("should process input and output as objects", async () => {
  const addOne = jest.fn((x: number): number => x + 1);
  const chain = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));

  const app = new Pregel({
    nodes: { one: chain },
    input: ["input"],
    output: ["output"]
  });

  expect(await app.invoke({ input: 2 })).toEqual({ output: 3 });
});

it.skip("should invoke two processes and get correct output", async () => {
  // const addOne = jest.fn((x: number): number => x + 1);
  const addOne = jest.fn((x: { "": number }): number => x[""] + 1);

  const one = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo("inbox"));
  const two = Channel.subscribeTo("inbox")
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));

  const app = new Pregel({
    nodes: { one, two }
  });

  expect(await app.invoke(2)).toEqual(4);

  for await (const [step, values] of await app.stream(2)) {
    if (step === 0) {
      expect(values).toEqual({ inbox: 3 });
    } else if (step === 1) {
      expect(values).toEqual({ output: 4 });
    }
  }
});

it.skip("should modify inbox value and get different output", async () => {
  // const addOne = jest.fn((x: number): number => x + 1);
  const addOne = jest.fn((x: { "": number }): number => x[""] + 1);

  const one = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo("inbox"));
  const two = Channel.subscribeTo("inbox")
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));

  const app = new Pregel({
    nodes: { one, two }
  });

  let step = 0;
  for await (const values of await app.stream(2)) {
    if (step === 0) {
      expect(values).toEqual({ inbox: 3 });
      // modify inbox value
      values.inbox = 5;
    } else if (step === 1) {
      // output is different now
      expect(values).toEqual({ output: 6 });
    }
    step += 1;
  }
});

it.skip("should process two processes with object input and output", async () => {
  const addOne = jest.fn((x: number): number => x + 1);
  const one = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo("inbox"));
  const two = Channel.subscribeToEach("inbox")
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));

  const app = new Pregel({
    nodes: { one, two },
    channels: { inbox: new Topic<number>() },
    input: ["input", "inbox"]
  });

  const streamResult = await app.stream(
    { input: 2, inbox: 12 },
    undefined,
    "output"
  );
  const outputResults = [];
  for await (const result of streamResult) {
    outputResults.push(result);
  }
  expect(outputResults).toEqual([13, 4]); // [12 + 1, 2 + 1 + 1]

  const fullStreamResult = await app.stream({ input: 2, inbox: 12 });
  const fullOutputResults = [];
  for await (const result of fullStreamResult) {
    fullOutputResults.push(result);
  }
  expect(fullOutputResults).toEqual([
    { inbox: [3], output: 13 },
    { output: 4 }
  ]);
});

it("should process batch with two processes and delays", async () => {
  const addOneWithDelay = jest.fn(
    (inp: number): Promise<number> =>
      new Promise((resolve) => {
        setTimeout(() => resolve(inp + 1), inp * 100);
      })
  );

  const one = Channel.subscribeTo("input")
    .pipe(addOneWithDelay)
    .pipe(Channel.writeTo("one"));
  const two = Channel.subscribeTo("one")
    .pipe(addOneWithDelay)
    .pipe(Channel.writeTo("output"));

  const app = new Pregel({
    nodes: { one, two }
  });

  expect(await app.batch([3, 2, 1, 3, 5])).toEqual([5, 4, 3, 5, 7]);
  expect(await app.batch([3, 2, 1, 3, 5], { output: ["output"] })).toEqual([
    { output: 5 },
    { output: 4 },
    { output: 3 },
    { output: 5 },
    { output: 7 }
  ]);
});

it("should process batch with two processes and delays with graph", async () => {
  const addOneWithDelay = jest.fn(
    (inp: number): Promise<number> =>
      new Promise((resolve) => {
        setTimeout(() => resolve(inp + 1), inp * 100);
      })
  );

  const graph = new Graph();
  graph.addNode("add_one", addOneWithDelay);
  graph.addNode("add_one_more", addOneWithDelay);
  graph.setEntryPoint("add_one");
  graph.setFinishPoint("add_one_more");
  graph.addEdge("add_one", "add_one_more");
  const gapp = graph.compile();

  expect(await gapp.batch([3, 2, 1, 3, 5])).toEqual([5, 4, 3, 5, 7]);
});

it.skip("should invoke many processes in out", async () => {
  const testSize = 100;
  const addOne = jest.fn((x: number): number => x + 1);

  const nodes: Record<string, ChannelInvoke> = {
    "-1": Channel.subscribeTo("input").pipe(addOne).pipe(Channel.writeTo("-1"))
  };

  for (let i = 0; i < testSize - 2; i += 1) {
    nodes[String(i)] = Channel.subscribeTo(String(i - 1))
      .pipe(addOne)
      .pipe(Channel.writeTo(String(i)));
  }
  nodes.last = Channel.subscribeTo(String(testSize - 2))
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));

  const app = new Pregel({ nodes });

  for (let i = 0; i < 10; i += 1) {
    const result = await app.invoke(2, { recursionLimit: testSize });
    console.log("expected", result, "to equal", 2 + testSize);
    expect(result).toEqual(2 + testSize);
  }
});

it.skip("should process batch with many processes in and out", async () => {
  const testSize = 100;
  const addOne = jest.fn((x: number): number => x + 1);

  const nodes: Record<string, ChannelInvoke> = {
    "-1": Channel.subscribeTo("input").pipe(addOne).pipe(Channel.writeTo("-1"))
  };
  for (let i = 0; i < testSize - 2; i += 1) {
    nodes[String(i)] = Channel.subscribeTo(String(i - 1))
      .pipe(addOne)
      .pipe(Channel.writeTo(String(i)));
  }
  nodes.last = Channel.subscribeTo(String(testSize - 2))
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));

  const app = new Pregel({ nodes });

  for (let i = 0; i < 3; i += 1) {
    expect(
      await app.batch([2, 1, 3, 4, 5], { recursionLimit: testSize })
    ).toEqual([
      2 + testSize,
      1 + testSize,
      3 + testSize,
      4 + testSize,
      5 + testSize
    ]);
  }
});

it("should raise InvalidUpdateError when the same LastValue channel is updated twice in one iteration", async () => {
  const addOne = jest.fn((x: number): number => x + 1);

  const one = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));
  const two = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));

  const app = new Pregel({
    nodes: { one, two }
  });

  await expect(app.invoke(2)).rejects.toThrow(InvalidUpdateError);
});

it("should process two inputs to two outputs validly", async () => {
  const addOne = jest.fn((x: number): number => x + 1);

  const one = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));
  const two = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));

  const app = new Pregel({
    nodes: { one, two },
    channels: { output: new Topic<number>() }
  });

  // An Inbox channel accumulates updates into a sequence
  expect(await app.invoke(2)).toEqual([3, 3]);
});

it.only("should maintain state across invocations and handle exceptions", async () => {
  const addOne = jest.fn(
    (x: { total: number; input: number }): number => x.total + x.input
  );

  const raiseIfAbove10 = (input: number): number => {
    if (input > 10) {
      throw new Error("Input is too large");
    }
    return input;
  };

  const one = Channel.subscribeTo(["input"])
    .join(["total"])
    .pipe(addOne)
    .pipe(Channel.writeTo("output"))
    .pipe(raiseIfAbove10);

  const memory = new MemorySaver();

  const app = new Pregel({
    nodes: { one },
    channels: { total: new BinaryOperatorAggregate<number>((a, b) => a + b) },
    saver: memory
  });

  // total starts out as 0, so output is 0+2=2
  await expect(
    app.invoke(2, { configurable: { threadId: "1" } })
  ).resolves.toBe(2);
  let checkpoint = memory.get({ configurable: { threadId: "1" } });
  expect(checkpoint).not.toBeNull();
  expect(checkpoint?.channelValues.output).toBe(2);

  // total is now 2, so output is 2+3=5
  await expect(
    app.invoke(3, { configurable: { threadId: "1" } })
  ).resolves.toBe(5);
  checkpoint = memory.get({ configurable: { threadId: "1" } });
  expect(checkpoint).not.toBeNull();
  expect(checkpoint?.channelValues.output).toBe(7);

  // total is now 2+5=7, so output would be 7+4=11, but raises Error
  await expect(
    app.invoke(4, { configurable: { threadId: "1" } })
  ).rejects.toThrow("Input is too large");
  // checkpoint is not updated
  checkpoint = memory.get({ configurable: { threadId: "1" } });
  expect(checkpoint).not.toBeNull();
  expect(checkpoint?.channelValues.output).toBe(7);

  // on a new thread, total starts out as 0, so output is 0+5=5
  await expect(
    app.invoke(5, { configurable: { threadId: "2" } })
  ).resolves.toBe(5);
  checkpoint = memory.get({ configurable: { threadId: "1" } });
  expect(checkpoint).not.toBeNull();
  expect(checkpoint?.channelValues.output).toBe(7);
  checkpoint = memory.get({ configurable: { threadId: "2" } });
  expect(checkpoint).not.toBeNull();
  expect(checkpoint?.channelValues.output).toBe(5);
});