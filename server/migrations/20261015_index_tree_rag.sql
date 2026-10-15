alter table
    public.projects
add
    column if not exists rag_strategy text not null default 'vector';

do $migration$ begin if not exists (
    select
        1
    from
        pg_constraint
    where
        conname = 'projects_rag_strategy_check'
) then
alter table
    public.projects
add
    constraint projects_rag_strategy_check check (rag_strategy in ('vector', 'index_tree'));

end if;

end $migration$;

create unique index if not exists documents_id_project_owner_idx on public.documents (id, project_id, owner_clerk_id);

create table if not exists public.document_index_trees (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null,
    document_id uuid not null unique,
    owner_clerk_id text not null,
    strategy text not null default 'index_tree' check (strategy = 'index_tree'),
    status text not null default 'pending' check (
        status in ('pending', 'processing', 'completed', 'failed')
    ),
    schema_version integer not null default 1 check (schema_version > 0),
    root_node_id uuid,
    metadata jsonb not null default '{}' :: jsonb,
    error_message text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (
        (status = 'completed') = (root_node_id is not null)
    ),
    foreign key (document_id, project_id, owner_clerk_id) references public.documents (id, project_id, owner_clerk_id) on delete cascade
);

create index if not exists document_index_trees_project_status_idx on public.document_index_trees (project_id, status);

create index if not exists document_index_trees_owner_project_idx on public.document_index_trees (owner_clerk_id, project_id);

create table if not exists public.document_index_tree_nodes (
    id uuid primary key,
    tree_id uuid not null references public.document_index_trees (id) on delete cascade,
    parent_node_id uuid,
    node_type text not null check (
        node_type in (
            'root',
            'chapter',
            'section',
            'subsection',
            'leaf'
        )
    ),
    title text not null check (length(trim(title)) > 0),
    summary text,
    content_reference text,
    start_page integer not null check (start_page > 0),
    end_page integer not null check (end_page >= start_page),
    depth integer not null check (depth >= 0),
    sort_order integer not null check (sort_order >= 0),
    metadata jsonb not null default '{}' :: jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (id, tree_id),
    check ((node_type = 'root') = (parent_node_id is null)),
    check (
        parent_node_id is null
        or parent_node_id <> id
    ),
    check (
        node_type <> 'leaf'
        or content_reference is not null
    ),
    foreign key (parent_node_id, tree_id) references public.document_index_tree_nodes (id, tree_id) on delete cascade deferrable initially deferred
);

create unique index if not exists document_index_tree_nodes_one_root_idx on public.document_index_tree_nodes (tree_id)
where
    parent_node_id is null;

create index if not exists document_index_tree_nodes_parent_order_idx on public.document_index_tree_nodes (tree_id, parent_node_id, sort_order);

create index if not exists document_index_tree_nodes_tree_page_idx on public.document_index_tree_nodes (tree_id, start_page, end_page);

do $migration$ begin if not exists (
    select
        1
    from
        pg_constraint
    where
        conname = 'document_index_trees_root_node_fk'
) then
alter table
    public.document_index_trees
add
    constraint document_index_trees_root_node_fk foreign key (root_node_id, id) references public.document_index_tree_nodes (id, tree_id) deferrable initially deferred;

end if;

end $migration$;

create
or replace function public.prevent_document_index_tree_cycles() returns trigger language plpgsql
set
    search_path = '' as $function$ begin if new.parent_node_id is null then return new;

end if;

if exists (
    with recursive ancestors(id, parent_node_id) as (
        select
            node.id,
            node.parent_node_id
        from
            public.document_index_tree_nodes as node
        where
            node.id = new.parent_node_id
            and node.tree_id = new.tree_id
        union
        select
            parent.id,
            parent.parent_node_id
        from
            public.document_index_tree_nodes as parent
            inner join ancestors on parent.id = ancestors.parent_node_id
        where
            parent.tree_id = new.tree_id
    )
    select
        1
    from
        ancestors
    where
        id = new.id
) then raise exception 'Index tree nodes cannot contain a cycle';

end if;

return new;

end $function$;

drop trigger if exists document_index_tree_nodes_no_cycles on public.document_index_tree_nodes;

create trigger document_index_tree_nodes_no_cycles before
insert
    or
update
    of parent_node_id,
    tree_id on public.document_index_tree_nodes for each row execute function public.prevent_document_index_tree_cycles();

create
or replace function public.save_document_index_tree(
    p_tree_id uuid,
    p_root_node_id uuid,
    p_nodes jsonb
) returns void language plpgsql security definer
set
    search_path = '' as $function$ begin if not exists (
        select
            1
        from
            public.document_index_trees
        where
            id = p_tree_id
            and status = 'processing'
    ) then raise exception 'Index tree is no longer active';

end if;

delete from
    public.document_index_tree_nodes
where
    tree_id = p_tree_id;

insert into
    public.document_index_tree_nodes (
        id,
        tree_id,
        parent_node_id,
        node_type,
        title,
        summary,
        content_reference,
        start_page,
        end_page,
        depth,
        sort_order,
        metadata
    )
select
    node.id,
    p_tree_id,
    node.parent_node_id,
    node.node_type,
    node.title,
    node.summary,
    node.content_reference,
    node.start_page,
    node.end_page,
    node.depth,
    node.sort_order,
    coalesce(node.metadata, '{}' :: jsonb)
from
    jsonb_to_recordset(p_nodes) as node(
        id uuid,
        parent_node_id uuid,
        node_type text,
        title text,
        summary text,
        content_reference text,
        start_page integer,
        end_page integer,
        depth integer,
        sort_order integer,
        metadata jsonb
    );

update
    public.document_index_trees
set
    root_node_id = p_root_node_id,
    status = 'completed',
    error_message = null,
    updated_at = now()
where
    id = p_tree_id
    and status = 'processing';

if not found then raise exception 'Index tree was deleted during indexing';

end if;

end $function$;

revoke all on function public.save_document_index_tree(uuid, uuid, jsonb)
from
    public,
    anon,
    authenticated;

grant execute on function public.save_document_index_tree(uuid, uuid, jsonb) to service_role;

alter table
    public.document_index_trees enable row level security;

alter table
    public.document_index_tree_nodes enable row level security;

revoke all on public.document_index_trees,
public.document_index_tree_nodes
from
    anon,
    authenticated;

grant all on public.document_index_trees,
public.document_index_tree_nodes to service_role;