create extension if not exists pgcrypto;

create table if not exists public.projects (
    id uuid primary key default gen_random_uuid(),
    owner_clerk_id text not null,
    name varchar(120) not null check (length(trim(name)) > 0),
    description text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (id, owner_clerk_id)
);

create index if not exists projects_owner_updated_idx on public.projects (owner_clerk_id, updated_at desc);

create table if not exists public.documents (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null,
    owner_clerk_id text not null,
    file_name text not null check (length(trim(file_name)) > 0),
    storage_path text not null unique,
    mime_type text not null check (mime_type = 'application/pdf'),
    file_size bigint not null check (
        file_size > 0
        and file_size <= 26214400
    ),
    checksum char(64),
    processing_status text not null default 'pending' check (
        processing_status in ('pending', 'processing', 'completed', 'failed')
    ),
    processing_error text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    foreign key (project_id, owner_clerk_id) references public.projects (id, owner_clerk_id) on delete cascade
);

create index if not exists documents_project_created_idx on public.documents (project_id, created_at desc);

create index if not exists documents_owner_project_idx on public.documents (owner_clerk_id, project_id);

create table if not exists public.conversations (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null,
    owner_clerk_id text not null,
    title varchar(120) not null default 'New conversation',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (id, project_id, owner_clerk_id),
    foreign key (project_id, owner_clerk_id) references public.projects (id, owner_clerk_id) on delete cascade
);

create index if not exists conversations_project_updated_idx on public.conversations (project_id, updated_at desc);

create index if not exists conversations_owner_project_idx on public.conversations (owner_clerk_id, project_id);

create table if not exists public.messages (
    id uuid primary key default gen_random_uuid(),
    conversation_id uuid not null,
    project_id uuid not null,
    owner_clerk_id text not null,
    role text not null check (role in ('user', 'assistant')),
    content text not null,
    sequence_number bigint not null check (sequence_number > 0),
    metadata jsonb not null default '{}' :: jsonb,
    created_at timestamptz not null default now(),
    unique (conversation_id, sequence_number),
    foreign key (conversation_id, project_id, owner_clerk_id) references public.conversations (id, project_id, owner_clerk_id) on delete cascade
);

create index if not exists messages_conversation_sequence_idx on public.messages (conversation_id, sequence_number);

create index if not exists messages_owner_project_idx on public.messages (owner_clerk_id, project_id);

create
or replace function public.save_chat_exchange(
    p_owner_clerk_id text,
    p_project_id uuid,
    p_conversation_id uuid,
    p_question text,
    p_answer text,
    p_metadata jsonb
) returns setof public.messages language sql security definer
set
    search_path = '' begin atomic with locked_conversation as materialized (
        select
            id
        from
            public.conversations
        where
            id = p_conversation_id
            and project_id = p_project_id
            and owner_clerk_id = p_owner_clerk_id for
        update
    ),
    next_sequence as (
        select
            coalesce(max(messages.sequence_number), 0) + 1 as first_sequence
        from
            public.messages as messages
            cross join locked_conversation
        where
            messages.conversation_id = p_conversation_id
    ),
    entries as (
        select
            'user' :: text as role,
            p_question as content,
            '{}' :: jsonb as metadata,
            0 :: bigint as sequence_offset
        union
        all
        select
            'assistant' :: text,
            p_answer,
            coalesce(p_metadata, '{}' :: jsonb),
            1 :: bigint
    ),
    inserted_messages as (
        insert into
            public.messages (
                conversation_id,
                project_id,
                owner_clerk_id,
                role,
                content,
                sequence_number,
                metadata
            )
        select
            p_conversation_id,
            p_project_id,
            p_owner_clerk_id,
            entries.role,
            entries.content,
            next_sequence.first_sequence + entries.sequence_offset,
            entries.metadata
        from
            locked_conversation
            cross join next_sequence
            cross join entries returning *
    ),
    updated_conversation as (
        update
            public.conversations as conversation
        set
            updated_at = now(),
            title = case
                when conversation.title = 'New conversation' then left(p_question, 80)
                else conversation.title
            end
        from
            locked_conversation
        where
            conversation.id = locked_conversation.id returning conversation.id
    )
select
    inserted_messages.*
from
    inserted_messages
    cross join updated_conversation
order by
    inserted_messages.sequence_number;

end;

revoke all on function public.save_chat_exchange(text, uuid, uuid, text, text, jsonb)
from
    public,
    anon,
    authenticated;

grant execute on function public.save_chat_exchange(text, uuid, uuid, text, text, jsonb) to service_role;

alter table
    public.projects enable row level security;

alter table
    public.documents enable row level security;

alter table
    public.conversations enable row level security;

alter table
    public.messages enable row level security;

revoke all on public.projects,
public.documents,
public.conversations,
public.messages
from
    anon,
    authenticated;

grant all on public.projects,
public.documents,
public.conversations,
public.messages to service_role;

insert into
    storage.buckets (
        id,
        name,
        public,
        file_size_limit,
        allowed_mime_types
    )
values
    (
        'documents',
        'documents',
        false,
        26214400,
        array ['application/pdf']
    ) on conflict (id) do
update
set
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;