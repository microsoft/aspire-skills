Console.WriteLine("Continue?");
while (Console.ReadLine() is { } input)
{
    if (input == "quit")
    {
        return;
    }
    if (input == "yes")
    {
        Console.WriteLine("Setup complete");
    }
    else if (input == "help")
    {
        Console.WriteLine("Available commands: yes, help, quit");
    }
    else
    {
        Console.WriteLine("Unknown command");
    }
    Console.Write("repl>");
}
