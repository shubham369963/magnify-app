create table if not exists public.project_index_trees (
    project_id uuid primary key,
    owner_clerk_id text not null,
    strategy text not null default 'index_tree' check (strategy = 'index_tree'),
    status text not null default 'pending' check (
        status in ('pending', 'processing', 'completed', 'failed')
    ),
    generation bigint not null default 0 check (generation >= 0),
    schema_version integer not null default 1 check (schema_version > 0),
    tree jsonb not null default '{"type":"root","title":"Project index","children":[]}' :: jsonb check (jsonb_typeof(tree) = 'object'),
    metadata jsonb not null default '{}' :: jsonb,
    error_message text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    foreign key (project_id, owner_clerk_id) references public.projects (id, owner_clerk_id) on delete cascade
);

create index if not exists project_index_trees_owner_status_idx on public.project_index_trees (owner_clerk_id, status);

create
or replace function public.request_project_index_tree(
    p_project_id uuid,
    p_owner_clerk_id text
) returns bigint language plpgsql security definer
set
    search_path = '' as $function$ declare requested_generation bigint;

begin if not exists (
    select
        1
    from
        public.projects
    where
        id = p_project_id
        and owner_clerk_id = p_owner_clerk_id
) then raise exception 'Project not found';

end if;

insert into
    public.project_index_trees as existing_tree (project_id, owner_clerk_id, generation, status)
values
    (p_project_id, p_owner_clerk_id, 1, 'pending') on conflict (project_id) do
update
set
    generation = existing_tree.generation + 1,
    status = 'pending',
    error_message = null,
    updated_at = now()
where
    existing_tree.owner_clerk_id = excluded.owner_clerk_id returning generation into requested_generation;

if requested_generation is null then raise exception 'Project index tree ownership mismatch';

end if;

return requested_generation;

end;

$function$;

create
or replace function public.save_project_index_tree(
    p_project_id uuid,
    p_owner_clerk_id text,
    p_generation bigint,
    p_tree jsonb,
    p_source_document_ids jsonb,
    p_metadata jsonb
) returns void language plpgsql security definer
set
    search_path = '' as $function$ begin if jsonb_typeof(p_tree) <> 'object'
    or jsonb_typeof(p_source_document_ids) <> 'array' then raise exception 'Invalid project index tree';

end if;

if exists (
    select
        1
    from
        jsonb_array_elements_text(p_source_document_ids) as source(document_id)
    where
        not exists (
            select
                1
            from
                public.documents
            where
                id = source.document_id :: uuid
                and project_id = p_project_id
                and owner_clerk_id = p_owner_clerk_id
        )
) then raise exception 'Index tree references a document outside the project';

end if;

update
    public.project_index_trees
set
    tree = p_tree,
    status = 'completed',
    metadata = coalesce(p_metadata, '{}' :: jsonb),
    error_message = null,
    updated_at = now()
where
    project_id = p_project_id
    and owner_clerk_id = p_owner_clerk_id
    and generation = p_generation
    and exists (
        select
            1
        from
            public.projects
        where
            id = p_project_id
            and owner_clerk_id = p_owner_clerk_id
    );

if not found then raise exception 'Project index request is stale or the project was deleted';

end if;

end;

$function$;

create
or replace function public.fail_project_index_tree(
    p_project_id uuid,
    p_owner_clerk_id text,
    p_generation bigint,
    p_error_message text
) returns void language sql security definer
set
    search_path = '' as $function$
update
    public.project_index_trees
set
    status = 'failed',
    error_message = left(p_error_message, 1000),
    updated_at = now()
where
    project_id = p_project_id
    and owner_clerk_id = p_owner_clerk_id
    and generation = p_generation $function$;

create
or replace function public.get_project_index_tree(
    p_project_id uuid,
    p_owner_clerk_id text
) returns setof public.project_index_trees language sql security definer
set
    search_path = '' as $function$
select
    *
from
    public.project_index_trees
where
    project_id = p_project_id
    and owner_clerk_id = p_owner_clerk_id $function$;

revoke all on function public.request_project_index_tree(uuid, text)
from
    public,
    anon,
    authenticated;

revoke all on function public.save_project_index_tree(uuid, text, bigint, jsonb, jsonb, jsonb)
from
    public,
    anon,
    authenticated;

revoke all on function public.fail_project_index_tree(uuid, text, bigint, text)
from
    public,
    anon,
    authenticated;

revoke all on function public.get_project_index_tree(uuid, text)
from
    public,
    anon,
    authenticated;

grant execute on function public.request_project_index_tree(uuid, text) to service_role;

grant execute on function public.save_project_index_tree(uuid, text, bigint, jsonb, jsonb, jsonb) to service_role;

grant execute on function public.fail_project_index_tree(uuid, text, bigint, text) to service_role;

grant execute on function public.get_project_index_tree(uuid, text) to service_role;

insert into
    public.project_index_trees (
        project_id,
        owner_clerk_id,
        status,
        tree,
        metadata,
        error_message
    )
select
    legacy.project_id,
    legacy.owner_clerk_id,
    case
        when bool_and(legacy.status = 'completed') then 'completed'
        when bool_or(legacy.status = 'processing') then 'processing'
        when bool_or(legacy.status = 'failed') then 'failed'
        else 'pending'
    end,
    jsonb_build_object(
        'type',
        'root',
        'title',
        'Project index',
        'children',
        jsonb_agg(
            jsonb_build_object(
                'type',
                'document',
                'title',
                legacy.file_name,
                'document_id',
                legacy.document_id,
                'root_node_id',
                legacy.root_node_id,
                'nodes',
                legacy.nodes
            )
            order by
                legacy.file_name,
                legacy.document_id
        )
    ),
    jsonb_build_object('source_document_count', count(*)),
    left(
        string_agg(legacy.error_message, '; ') filter (
            where
                legacy.error_message is not null
        ),
        1000
    )
from
    (
        select
            index_tree.project_id,
            index_tree.owner_clerk_id,
            index_tree.document_id,
            index_tree.status,
            index_tree.root_node_id,
            index_tree.error_message,
            document.file_name,
            coalesce(
                (
                    select
                        jsonb_agg(
                            jsonb_build_object(
                                'id',
                                node.id,
                                'parent_node_id',
                                node.parent_node_id,
                                'type',
                                node.node_type,
                                'title',
                                node.title,
                                'summary',
                                node.summary,
                                'content_reference',
                                node.content_reference,
                                'start_page',
                                node.start_page,
                                'end_page',
                                node.end_page,
                                'depth',
                                node.depth,
                                'sort_order',
                                node.sort_order,
                                'metadata',
                                node.metadata
                            )
                            order by
                                node.depth,
                                node.sort_order,
                                node.start_page
                        )
                    from
                        public.document_index_tree_nodes as node
                    where
                        node.tree_id = index_tree.id
                ),
                '[]' :: jsonb
            ) as nodes
        from
            public.document_index_trees as index_tree
            inner join public.documents as document on document.id = index_tree.document_id
            and document.project_id = index_tree.project_id
            and document.owner_clerk_id = index_tree.owner_clerk_id
    ) as legacy
group by
    legacy.project_id,
    legacy.owner_clerk_id on conflict (project_id) do
update
set
    status = excluded.status,
    tree = excluded.tree,
    metadata = excluded.metadata,
    error_message = excluded.error_message,
    updated_at = now();

drop table if exists public.document_index_tree_nodes cascade;

drop table if exists public.document_index_trees cascade;

drop function if exists public.save_document_index_tree(uuid, uuid, jsonb);

drop function if exists public.prevent_document_index_tree_cycles();

alter table
    public.project_index_trees enable row level security;

revoke all on public.project_index_trees
from
    anon,
    authenticated;

grant all on public.project_index_trees to service_role;