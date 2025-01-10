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

interface RepoArgs {
  command: string;
}

const isValidRepoArgs = (args: any): args is RepoArgs =>
  typeof args === 'object' &&
  args !== null &&
  typeof args.command === 'string';

interface ParsedCommand {
  mode: 'create' | 'update-description' | 'update-tags' | 'update-website';
  name?: string;
  description?: string;
  tags?: string[];
  website?: string;
}

const parseCommand = (command: string): ParsedCommand => {
  const lowercaseCommand = command.toLowerCase();
  
  // Check for update commands
  if (lowercaseCommand.includes('update') || lowercaseCommand.includes('change') || lowercaseCommand.includes('set')) {
    // Extract repository name - common for all update commands
    const repoMatch = command.match(/(?:update|change|set|modify)\s+(?:the\s+)?(?:repository\s+)?([a-zA-Z0-9-_/]+)/i);
    if (!repoMatch) {
      throw new McpError(ErrorCode.InvalidParams, 'Repository name not found in update command');
    }
    const repoName = repoMatch[1];

    // Check for description update
    if (lowercaseCommand.includes('description')) {
      const descMatch = command.match(/description\s+(?:to|as)\s+["']?([^"']+)["']?/i);
      if (!descMatch) {
        throw new McpError(ErrorCode.InvalidParams, 'New description not found in update command');
      }
      return {
        mode: 'update-description',
        name: repoName,
        description: descMatch[1].trim()
      };
    }

    // Check for tags update
    if (lowercaseCommand.includes('tags') || lowercaseCommand.includes('topics')) {
      return {
        mode: 'update-tags',
        name: repoName,
        tags: extractTags(command)
      };
    }

    // Check for website update
    if (lowercaseCommand.includes('website') || lowercaseCommand.includes('homepage') || lowercaseCommand.includes('url')) {
      const website = extractWebsite(command);
      if (!website) {
        throw new McpError(ErrorCode.InvalidParams, 'New website URL not found in update command');
      }
      return {
        mode: 'update-website',
        name: repoName,
        website
      };
    }

    throw new McpError(ErrorCode.InvalidParams, 'Unknown update type. Use "description", "tags", or "website".');
  }
  
  // This is a create command
  const descMatch = command.match(/(?:create|make|new)\s+(?:a\s+)?(?:repository\s+)?(?:for|called|named)?\s+([^,\.]+)/i);
  if (!descMatch) {
    throw new McpError(ErrorCode.InvalidParams, 'Repository description not found in create command');
  }

  return {
    mode: 'create',
    description: descMatch[1].trim(),
    tags: extractTags(command),
    website: extractWebsite(command)
  };
};

const extractTags = (command: string): string[] => {
  // Look for tags/topics after keywords, excluding the "to" keyword
  const tagMatch = command.match(/(?:tags|topics|labeled|tagged)\s+(?:to|as)\s+["']?([^"']+)["']?/i);
  if (!tagMatch) return [];
  
  // Split tags by spaces or commas and clean them up
  return tagMatch[1]
    .split(/[\s,]+/)
    .filter(tag => tag.toLowerCase() !== 'to') // Extra safety to filter out "to"
    .map(tag => tag.toLowerCase()
      .trim()
      .replace(/[^a-z0-9-]/g, '-') // Replace invalid chars with hyphens
      .replace(/^-+|-+$/g, '') // Remove leading/trailing hyphens
      .substring(0, 50)) // Limit to 50 chars
    .filter(tag => 
      tag.length > 0 && 
      tag.length <= 50 &&
      /^[a-z0-9]/.test(tag)); // Must start with lowercase letter or number
};

const extractWebsite = (command: string): string | undefined => {
  // Look for website/homepage/url after keywords
  const websiteMatch = command.match(/(?:website|homepage|url)\s+(?:to|as)\s+["']?([^"'\s]+)["']?/i);
  return websiteMatch ? websiteMatch[1] : undefined;
};

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
          description: 'Create or update GitHub repositories using natural language commands',
          inputSchema: {
            type: 'object',
            properties: {
              command: {
                type: 'string',
                description: 'Natural language command like "Create a repository for my machine learning project with tags python tensorflow" or "Update repository-name description to New description with tags updated ml"'
              }
            },
            required: ['command'],
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

      if (!isValidRepoArgs(request.params.arguments)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'Invalid command format'
        );
      }

      try {
        const parsed = parseCommand(request.params.arguments.command);

        let response;
        if (parsed.mode === 'create') {
          // Generate a repository name based on the description
          const repoName = parsed.description!
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');

          // Create the repository
          response = await this.octokit.rest.repos.createForAuthenticatedUser({
            name: repoName,
            description: parsed.description,
            homepage: parsed.website,
            topics: parsed.tags,
            auto_init: true,
          });
        } else {
          // Handle different types of updates
          const [owner, repo] = parsed.name!.split('/');
          
          switch (parsed.mode) {
            case 'update-description':
              response = await this.octokit.rest.repos.update({
                owner,
                repo,
                description: parsed.description,
              });
              break;

            case 'update-tags':
              response = await this.octokit.rest.repos.replaceAllTopics({
                owner,
                repo,
                names: parsed.tags || [],
              });
              break;

            case 'update-website':
              response = await this.octokit.rest.repos.update({
                owner,
                repo,
                homepage: parsed.website,
              });
              break;
          }
        }

        // Format response based on operation type
        const formatResponse = () => {
          switch (parsed.mode) {
            case 'create': {
              const repo = response.data as {
                html_url: string;
                name: string;
                description: string;
                topics: string[];
                homepage: string | null;
              };
              return {
                message: 'Repository created successfully',
                url: repo.html_url,
                name: repo.name,
                description: repo.description,
                topics: repo.topics,
                homepage: repo.homepage,
              };
            }
            case 'update-description': {
              const repo = response.data as {
                name: string;
                description: string;
              };
              return {
                message: 'Repository description updated',
                name: repo.name,
                description: repo.description,
              };
            }
            case 'update-tags': {
              const topics = response.data as {
                names: string[];
              };
              return {
                message: 'Repository topics updated',
                topics: topics.names,
              };
            }
            case 'update-website': {
              const repo = response.data as {
                name: string;
                homepage: string | null;
              };
              return {
                message: 'Repository website updated',
                name: repo.name,
                homepage: repo.homepage,
              };
            }
          }
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(formatResponse(), null, 2),
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
