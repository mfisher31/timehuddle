/**
 * Tool schemas for the Ozwell AI agent.
 *
 * These definitions are used when registering tools with the Ozwell Agent
 * Registration API (server-side) and optionally inline via OzwellChatConfig
 * when using a parent key. The tool handlers themselves live in OzwellWidget.tsx.
 *
 * https://mieweb.github.io/ozwellai-api/backend/agents
 */

export interface OzwellToolParam {
  type: string;
  description: string;
  enum?: string[];
}

export interface OzwellTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, OzwellToolParam>;
      required: string[];
    };
  };
}

export const OZWELL_TOOLS: OzwellTool[] = [
  // ── Navigation ─────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'navigate',
      description:
        'Navigate the user to a different page in the TimeHuddle app. Use this when the user asks to go somewhere or open a section.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'App route path, e.g. /app/dashboard, /app/clock, /app/tickets, /app/work, /app/timesheet, /app/teams, /app/messages, /app/notifications, /app/activity, /app/settings',
          },
        },
        required: ['path'],
      },
    },
  },

  // ── Read context ────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'get_current_user',
      description: "Get the currently logged-in user's name, email, and ID.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_current_page',
      description: 'Get the current page/route the user is viewing.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_current_team',
      description: "Get the currently selected team's name, ID, and member count.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_teams',
      description: 'List all teams the user belongs to.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },

  // ── Clock ───────────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'get_clock_status',
      description: 'Check whether the user is currently clocked in or out and when they started.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clock_in',
      description:
        'Clock the user in. ' + 'Only call this when the user explicitly asks to clock in.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clock_out',
      description: 'Clock the user out.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_timesheet_entry',
      description: 'Update the start or end time of a timesheet (clock) entry by its ID.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Clock event ID to update' },
          startTime: {
            type: 'string',
            description: 'New start time as ISO 8601 string (optional)',
          },
          endTime: { type: 'string', description: 'New end time as ISO 8601 string (optional)' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_timesheet_entry',
      description: 'Delete a timesheet (clock) entry by its ID. This cannot be undone.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Clock event ID to delete' },
        },
        required: ['id'],
      },
    },
  },

  // ── Tickets ─────────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'get_tickets',
      description: 'Get all tickets for the currently selected team.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_ticket',
      description:
        'Create a new ticket in the currently selected team. Only call this when the user EXPLICITLY asks to create a new ticket. Do NOT call this as part of starting a timer. ' +
        'If the user provides a GitHub issue or PR URL, pass it as the title — the system will auto-fetch the real title and body from GitHub.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description:
              'Ticket title. If this is a GitHub issue/PR URL (e.g. https://github.com/org/repo/issues/1), the real title and description will be fetched automatically.',
          },
          description: {
            type: 'string',
            description:
              'Optional description. Omit if a GitHub URL is provided — the body will be fetched automatically.',
          },
          github: {
            type: 'string',
            description:
              'GitHub issue or PR URL to link to this ticket (optional, only provide if the title is NOT already a URL).',
          },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_ticket',
      description:
        "Update a ticket's title, description, status, or priority. Only provide the fields you want to change.",
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Ticket ID to update' },
          title: { type: 'string', description: 'New title (optional)' },
          description: { type: 'string', description: 'New description (optional)' },
          status: {
            type: 'string',
            description: 'New status (optional)',
            enum: ['open', 'in-progress', 'done', 'blocked'],
          },
          priority: {
            type: 'string',
            description: 'New priority (optional)',
            enum: ['low', 'medium', 'high', 'critical'],
          },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_ticket',
      description:
        'Delete a ticket by its ID. This cannot be undone — confirm with the user first.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Ticket ID to delete' },
        },
        required: ['id'],
      },
    },
  },

  // ── Teams ───────────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'switch_team',
      description:
        'Switch the active team context. Use this whenever the user asks to switch teams, change teams, or select a different team. ' +
        'This does NOT clock the user in or out — it only changes which team is active in the app. ' +
        'Responds with alreadySelected: true if the user is already on the requested team.',
      parameters: {
        type: 'object',
        properties: {
          teamId: { type: 'string', description: 'ID of the team to switch to (preferred)' },
          name: {
            type: 'string',
            description: 'Name of the team to switch to (used if teamId is unknown)',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_team',
      description: 'Create a new team.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Team name' },
          description: { type: 'string', description: 'Optional team description' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_team',
      description: 'Rename a team by its ID.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Team ID to rename' },
          name: { type: 'string', description: 'New team name' },
        },
        required: ['id', 'name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_team',
      description:
        'Delete a team by its ID. This is destructive and cannot be undone — always confirm with the user first.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Team ID to delete' },
        },
        required: ['id'],
      },
    },
  },

  // ── Clock Sessions ───────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'get_clock_sessions',
      description:
        'Get clock-in/clock-out sessions (team attendance records) for a date range. Use this to answer questions about how long the user worked, when they clocked in/out, or to summarise work across multiple days. Returns sessions with start/end times, duration, team name, and a summary total. IMPORTANT: To query a specific team, pass team_id or team_name directly — do NOT call switch_team first.',
      parameters: {
        type: 'object',
        properties: {
          start_date: {
            type: 'string',
            description: 'Start of date range in YYYY-MM-DD format. Defaults to today if omitted.',
          },
          end_date: {
            type: 'string',
            description:
              'End of date range in YYYY-MM-DD format (inclusive). Defaults to start_date if omitted.',
          },
          team_id: {
            type: 'string',
            description:
              'Filter results to a specific team by ID. Omit to use the currently selected team.',
          },
          team_name: {
            type: 'string',
            description:
              'Filter results to a specific team by name (case-insensitive partial match). Use this when the user mentions a team by name.',
          },
        },
        required: [],
      },
    },
  },

  // ── Work / Timers ───────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'get_work_items',
      description:
        'Get the list of work items (ticket timer rows) for a given date. Returns each work item with its ticket ID, title, and any timer sessions. NOTE: This only returns ticket-level timers, not clock-in/out sessions — use get_clock_sessions for attendance history.',
      parameters: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            description: 'Local date in YYYY-MM-DD format. Defaults to today if omitted.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_work_item',
      description:
        'Add an existing ticket to the Work page for a given date, creating a timer row without starting the clock. The ticket must already exist in the selected team.',
      parameters: {
        type: 'object',
        properties: {
          ticketId: { type: 'string', description: 'ID of the existing ticket to add' },
          date: {
            type: 'string',
            description: 'Local date in YYYY-MM-DD format. Defaults to today if omitted.',
          },
          note: { type: 'string', description: 'Optional note to attach to the work item' },
        },
        required: ['ticketId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_work_timer',
      description:
        'Start a timer for an existing work item (identified by its workItemId). The user must already be clocked in. Use start_ticket_timer instead if you only have a ticket title or ID.',
      parameters: {
        type: 'object',
        properties: {
          workItemId: {
            type: 'string',
            description: 'Work item (entry) ID to start the timer for',
          },
        },
        required: ['workItemId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop_work_timer',
      description: 'Stop a currently running timer session by its session ID.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Running timer session ID to stop' },
        },
        required: ['sessionId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_running_timer',
      description:
        "Get the user's currently running timer session, or null if no timer is active. Returns the session with its workItemId, startTime, and elapsed seconds.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_ticket_timer',
      description:
        'Start a timer for a specific ticket in the Work page. ' +
        'IMPORTANT RULES: ' +
        "(1) This tool NEVER creates a ticket — if the ticket doesn't exist, tell the user and offer to use create_ticket. " +
        '(2) The ticket must belong to the currently selected team — if not, use switch_team first. ' +
        '(3) The user must be clocked in to the selected team before a timer can start. ' +
        "(4) A work item row for today is automatically created if one doesn't exist. " +
        'Recommended flow: get_teams → switch_team → get_clock_status → clock_in (if needed) → get_tickets → start_ticket_timer.',
      parameters: {
        type: 'object',
        properties: {
          ticketId: {
            type: 'string',
            description: 'ID of the ticket to time (preferred). Must belong to the selected team.',
          },
          title: {
            type: 'string',
            description:
              'Title of the ticket to look up (used when ticketId is unknown). Must match an existing ticket in the selected team.',
          },
        },
        required: [],
      },
    },
  },
];
