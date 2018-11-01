import {
  APIDef,
  Capture,
  Placeholder,
  POST,
  ResponseDef,
  Success201
} from "../../types";

export type CreateAPI = APIDef<
  POST, // HTTP Method
  ["ping", Capture<":message">], // /ping/:message
  { apiKey: string }, // header
  { q: string }, // query
  CreateRequestBody, // Http Request Body
  {},
  ResponseDef<Success201, CreateResponseBody>
>;

type CreateRequestBody = {
  /**
   * @pattern [A-Z]+
   */
  email: string;
  /**
   * @maximum 1000
   * @minimum 0
   */
  id: Placeholder<number>;
};

type CreateResponseBody = {
  message: string;
};

const createAPIs: CreateAPI[] = [
  {
    request: {
      path: ["ping", "test"], // /ping/test
      headers: {
        apiKey: "{:apiKey}"
      },
      method: "POST",
      body: {
        email: "hoge@hoge.com{:apiKey}",
        id: "{:id}"
      },
      values: {
        id: 123
      }
    },
    response: {
      status: 201,
      body: { message: "test" }
    }
  }
];

module.exports = createAPIs;
