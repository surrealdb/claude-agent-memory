# Contributing

We would &nbsp;<img width="15" alt="Love" src="https://github.com/surrealdb/surrealdb/blob/main/img/love.svg?raw=true">&nbsp; for you to contribute to SurrealDB and help make it better! We want to ensure contributing to SurrealDB is fun, enjoyable, and educational for anyone and everyone. All contributions are welcome, including features, bug fixes, and documentation changes, as well as updates and tweaks, blog posts, workshops, and everything else.

## How to start

If you are worried or don't know where to start, you can ask us a question on [GitHub Discussions](https://github.com/surrealdb/surrealdb/discussions), or the [SurrealDB Discord Server](https://surrealdb.com/discord). Alternatively, you can message us on any channel in the [SurrealDB Community](https://surrealdb.com/community)!

## Code of conduct

Please help us keep SurrealDB open and inclusive. Kindly read and follow our [Code of Conduct](/CODE_OF_CONDUCT.md).

## Development

This package is built and tested with [Bun](https://bun.sh).

```bash
bun install
bun test
bun run typecheck
bun run build
```

The test suite needs no credentials and no running database. Most of it runs against a recording client double and a scripted message stream; `tests/integration.test.ts` additionally drives the real HTTP client against a local stub of the Agent Memory API, so the requests this package puts on the wire — paths, auth, scope normalisation, batch bodies — are covered too.

All four commands run in CI on every pull request, so run them locally before pushing.

The examples in `examples/` do need a live Agent Memory instance. Set `SPECTRON_ENDPOINT`, `SPECTRON_API_KEY`, and `SPECTRON_CONTEXT`, then:

```bash
bun run examples/drop-in.ts "I moved to Lisbon"
```

## Introducing new features

We would &nbsp;<img width="15" alt="Love" src="https://github.com/surrealdb/surrealdb/blob/main/img/love.svg?raw=true">&nbsp; for you to contribute to SurrealDB, but we would also like to make sure SurrealDB is as great as possible and loyal to its vision and mission statement. For us to find the right balance, please open a question on [GitHub discussions](https://github.com/surrealdb/surrealdb/discussions) with any ideas before creating a [**GitHub Issue**](/issues). This will allow the SurrealDB community to have sufficient discussion about the new feature value and how it fits in the product roadmap and vision, before introducing a new pull request.

This is also important for the SurrealDB lead developers to be able to give technical input and different emphasis regarding the feature design and architecture.

## Submitting a pull request

The **branch name** is your first opportunity to give your task context. Branch naming convention is as follows:

`TYPE-ISSUE_ID-DESCRIPTION`

It is recommended to combine the relevant [**GitHub Issue**](/issues) with a short description that describes the task resolved in this branch. If you don't have a GitHub issue for your PR, then you may avoid the prefix, but keep in mind that more likely you have to create the issue first. For example:

```
bugfix-548-await-writes-before-stream-close
```

Where `TYPE` can be one of the following:

- **refactor** - code change that neither fixes a bug nor adds a feature
- **feature** - code changes that add a new feature
- **bugfix** - code changes that fix a bug
- **docs** - documentation only changes
- **ci** - changes related to CI system

### Commit your changes

- Write a descriptive **summary**: The first line of your commit message should be a concise summary of the changes you are making. It should be no more than 50 characters and should describe the change in a way that is easy to understand.

- Provide more **details** in the body: The body of the commit message should provide more details about the changes you are making. Explain the problem you are solving, the changes you are making, and the reasoning behind those changes.

- Use the **commit history** in your favour: Small and self-contained commits allow the reviewer to see exactly how you solved the problem. By reading the commit history of the PR, the reviewer can already understand what they'll be reviewing, even before seeing a single line of code.

### Create a pull request

- The **title** of your pull request should be clear and descriptive. It should summarize the changes you are making in a concise manner.

- Provide a detailed **description** of the changes you are making. Explain the reasoning behind the changes, the problem it solves, and the impact it may have on the codebase. Keep in mind that a reviewer was not working on your task, so you should explain why you wrote the code the way you did.

- Describe the scene and provide everything that will help to understand the background and a context for the reviewers by adding related GitHub issues to the description, and links to the related PRs, projects or third-party documentation. If there are any potential drawbacks or trade-offs to your changes, be sure to mention them too.

- Be sure to **request reviews** from the appropriate people. The [`CODEOWNERS`](.github/CODEOWNERS) file assigns a default reviewer automatically.

### Finalize the change

- We are actively using **threads** to allow for more detailed and targeted discussions about specific parts of the pull request. A resolved thread means that the conversation has been addressed and the issue has been resolved. Reviewers are responsible for resolving the comment and not the author. The author can simply add a reply comment that the change has been done or decline a request.

- When your pull request is approved, our team will be sure to **merge it responsibly**. This might involve running additional tests or checks, ensuring that the codebase is still functional.

## Security and Privacy

We take the security of SurrealDB code, software, cloud platform, and client SDKs very seriously. If you believe you have found a security vulnerability, please follow our [Security Policy](/SECURITY.md) and report it to security@surrealdb.com rather than opening a public issue.

When developing, make sure to follow the best industry standards and practices.

## External dependencies

Please avoid introducing new dependencies without consulting the team. New dependencies can be very helpful but also introduce new security and privacy issues, complexity, and impact total package size. Adding a new dependency should have vital value on the product with minimum possible risk.

This package deliberately keeps a very small dependency surface: [`@surrealdb/spectron`](https://www.npmjs.com/package/@surrealdb/spectron) and `zod`, with the Claude Agent SDK as a peer dependency so consumers control its version.

## Other Ways to Help

Pull requests are great, but there are many other areas where you can help.

### Blogging and speaking

Blogging, speaking about, or creating tutorials about one of SurrealDB's many features. Mention [@surrealdb](https://twitter.com/surrealdb) on Twitter, and email community@surrealdb.com so we can give pointers and tips and help you spread the word by promoting your content on the different SurrealDB communication channels. Please add your blog posts and videos of talks to our [showcase](https://github.com/surrealdb/showcase) repo on GitHub.

### Feedback, bugs, and ideas

Sending feedback is a great way for us to understand your different use cases of SurrealDB better. If you want to share your experience, or if you want to discuss any ideas, you can start a discussion on [GitHub discussions](https://github.com/surrealdb/surrealdb/discussions), or chat with the [SurrealDB team on Discord](https://surrealdb.com/discord). If you have any issues or have found a bug, then feel free to create an issue on [**GitHub Issue**](/issues).

### Documentation improvements

Submitting [documentation](https://surrealdb.com/docs) updates, enhancements, designs, or bug fixes, and fixing any spelling or grammar errors will be very much appreciated.

### Joining our community

Join the growing [SurrealDB Community](https://surrealdb.com/community) around the world, for help, ideas, and discussions regarding SurrealDB.

- View our official [Blog](https://surrealdb.com/blog)
- Follow us on [Twitter](https://twitter.com/surrealdb)
- Connect with us on [LinkedIn](https://www.linkedin.com/company/surrealdb/)
- Join our [Dev community](https://dev.to/surrealdb)
- Chat live with us on [Discord](https://discord.gg/surrealdb)
- Get involved on [Reddit](http://reddit.com/r/surrealdb/)
- Read our blog posts on [Medium](https://medium.com/surrealdb)
- Questions tagged #surrealdb on [StackOverflow](https://stackoverflow.com/questions/tagged/surrealdb)
