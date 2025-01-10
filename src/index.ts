#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { Octokit } from 'octokit';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
  throw new Error('GITHUB_TOKEN environment variable is required');
}

interface CreateRepoArgs {
  description: string;
  tags: string;
  website?: string;
}

const isValidCreateRepoArgs = (args: any): args is CreateRepoArgs =>
  typeof args === 'object' &&
  args !== null &&
  typeof args.description === 'string' &&
  typeof args.tags === 'string' &&
  (args.website === undefined || typeof args.website === 'string');

class GitHubServer {
  private server: Server;
  private octokit: Octokit;

  constructor() {
    this.server = new Server(
      {
        name: 'github-server',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.octokit = new Octokit({
      auth: GITHUB_TOKEN,
    });

    this.setupToolHandlers();
    
    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'create_repo',
          description: 'Create a new GitHub repository with description, tags, and optional website',
          inputSchema: {
            type: 'object',
            properties: {
              description: {
                type: 'string',
                description: 'Short description of the repository',
              },
              tags: {
                type: 'string',
                description: 'Space-separated list of tags/topics',
              },
              website: {
                type: 'string',
                description: 'Optional website URL',
              },
            },
            required: ['description', 'tags'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name !== 'create_repo') {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${request.params.name}`
        );
      }

      if (!isValidCreateRepoArgs(request.params.arguments)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'Invalid repository creation arguments'
        );
      }

      try {
        // Generate a repository name based on the description
        const repoName = request.params.arguments.description
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');

        // Create the repository
        const response = await this.octokit.rest.repos.createForAuthenticatedUser({
          name: repoName,
          description: request.params.arguments.description,
          homepage: request.params.arguments.website,
          topics: request.params.arguments.tags.split(' ').filter(tag => tag.length > 0),
          auto_init: true,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                message: 'Repository created successfully',
                url: response.data.html_url,
                name: response.data.name,
                description: response.data.description,
                topics: response.data.topics,
                homepage: response.data.homepage,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        if (error instanceof Error) {
          return {
            content: [
              {
                type: 'text',
                text: `GitHub API error: ${error.message}`,
              },
            ],
            isError: true,
          };
        }
        throw error;
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('GitHub MCP server running on stdio');
  }
}

const server = new GitHubServer();
server.run().catch(console.error);
