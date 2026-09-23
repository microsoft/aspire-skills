using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

public sealed class ProbeDbContext(DbContextOptions<ProbeDbContext> options)
    : DbContext(options)
{
    public DbSet<ProbeMarker> ProbeMarkers => Set<ProbeMarker>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        ProbeModel.Configure(modelBuilder);
    }
}

public sealed class ProbeMarker
{
    public int Id { get; set; }

    public required string Value { get; set; }
}

internal static class ProbeModel
{
    public static void Configure(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<ProbeMarker>(entity =>
        {
            entity.ToTable("ProbeMarkers");
            entity.HasKey(marker => marker.Id);
            entity.Property(marker => marker.Id)
                .ValueGeneratedNever()
                .HasColumnType("integer");
            entity.Property(marker => marker.Value)
                .IsRequired()
                .HasColumnType("text");
            entity.HasData(new ProbeMarker
            {
                Id = 1,
                Value = "migration-applied"
            });
        });
    }
}

public partial class Initial : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "ProbeMarkers",
            columns: table => new
            {
                Id = table.Column<int>(type: "integer", nullable: false),
                Value = table.Column<string>(type: "text", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_ProbeMarkers", marker => marker.Id);
            });

        migrationBuilder.InsertData(
            table: "ProbeMarkers",
            columns: ["Id", "Value"],
            columnTypes: ["integer", "text"],
            values: [1, "migration-applied"]);
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(name: "ProbeMarkers");
    }
}

[DbContext(typeof(ProbeDbContext))]
[Migration("20260917000000_Initial")]
public partial class Initial
{
    protected override void BuildTargetModel(ModelBuilder modelBuilder)
    {
        modelBuilder.HasAnnotation("ProductVersion", "10.0.12");
        ProbeModel.Configure(modelBuilder);
    }
}

[DbContext(typeof(ProbeDbContext))]
public sealed class ProbeDbContextModelSnapshot : ModelSnapshot
{
    protected override void BuildModel(ModelBuilder modelBuilder)
    {
        modelBuilder.HasAnnotation("ProductVersion", "10.0.12");
        ProbeModel.Configure(modelBuilder);
    }
}
